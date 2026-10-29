import type { ExecutionPolicy, FilesystemPolicy } from '../shared/effective-permissions.js';
import { AppError, errorText, result, type Principal } from '../shared/protocol.js';
import { toolSchemas, toolScope, type ToolName } from '../shared/tools.js';
import type { RunnerConfig } from './config.js';
import { Policy } from './policy.js';
import { Files } from './files.js';
import { Processes } from './processes.js';
import { Git } from './git.js';
import { Editor } from './editor.js';
import { Context } from './context.js';
import type { AssistConsent } from './assist-consent.js';
import { parseUnifiedDiff } from './patch.js';

/** Serialize each project's mutations so expected hashes and moves are meaningful across concurrent clients. */
export class Tools {
  readonly policy: Policy; readonly files: Files; readonly processes: Processes; readonly git: Git;
  readonly editor: Editor; readonly context: Context;
  private locks = new Map<string, Promise<unknown>>();
  constructor(config: RunnerConfig, private deviceId?: string, private consent?: AssistConsent) {
    this.policy = new Policy(config, consent); this.files = new Files(this.policy); this.processes = new Processes(config, this.policy); this.git = new Git(this.policy);
    this.editor = new Editor(config, this.files); this.context = new Context(config, this.files, this.git, this.processes);
  }
  async invoke(name: string, input: Record<string, unknown>, principal: Principal, signal?: AbortSignal) {
    let executionPolicy: ExecutionPolicy | undefined;
    let filesystemPolicy: FilesystemPolicy | undefined;
    try {
      if (principal.tools && !principal.tools.includes(name)) throw new AppError('tool_forbidden', 'Tool is not enabled for this client authorization');
      if (!Object.hasOwn(toolSchemas, name)) throw new AppError('unknown_tool', 'Unknown tool');
      const tool = name as ToolName, args = toolSchemas[tool].parse(input);
      const guard = () => {
        if (signal?.aborted) throw new AppError('cancelled', 'Call cancelled');
        this.consent?.assertCall(principal, tool, args.projectId);
      };
      guard();
      const project = this.policy.project(args.projectId, principal, toolScope(tool), this.deviceId);
      if (this.consent) project.assertAccess = guard;
      executionPolicy = project.executionPolicy;
      filesystemPolicy = project.filesystemPolicy;
      const execute = async () => {
        await this.editor.ready;
        guard();
        const deadline = Math.min(principal.authorizationExpiresAt ?? Infinity, this.policy.expiresAt ?? Infinity, this.consent?.deadline(principal) ?? Infinity);
        const executionAuthorization = { authorizationId: principal.authorizationId, authorizationRevision: principal.authorizationRevision, authorizationExpiresAt: Number.isFinite(deadline) ? deadline : undefined, assist: principal.assist };
        if (toolScope(tool) !== 'read' && !['recover_edit_transaction', 'save_project_note'].includes(tool)) await this.editor.assertWritable(project);
        switch (tool) {
          case 'get_project_context': return { ...await this.context.get(project, principal.id, toolSchemas.get_project_context.parse(args).includeInstructions, signal), grantedScopes: principal.scopes, executionPolicy, filesystemPolicy };
          case 'save_project_note': return this.context.note(project, principal.id, toolSchemas.save_project_note.parse(args).text);
          case 'read_files': return this.files.readFiles(project, toolSchemas.read_files.parse(args));
          case 'edit_files': { const input = toolSchemas.edit_files.parse(args); return this.editor.edit(project, principal.id, input.changes, input.dryRun, signal); }
          case 'apply_unified_diff': { const input = toolSchemas.apply_unified_diff.parse(args); return this.editor.edit(project, principal.id, await parseUnifiedDiff(this.files, project, input.diff, input.expectedSha256), input.dryRun, signal); }
          case 'get_edit_transactions': return this.editor.list(project, principal.id);
          case 'recover_edit_transaction': return this.editor.recover(project, principal.id, toolSchemas.recover_edit_transaction.parse(args).transactionId);
          case 'list_directory': return this.files.list(project, toolSchemas.list_directory.parse(args));
          case 'read_file': return this.files.read(project, toolSchemas.read_file.parse(args));
          case 'write_file': return this.files.write(project, toolSchemas.write_file.parse(args));
          case 'create_directory': return this.files.mkdir(project, toolSchemas.create_directory.parse(args).path);
          case 'move_file': { const a = toolSchemas.move_file.parse(args); return this.files.move(project, a.source, a.destination); }
          case 'search_files': {
            const input = toolSchemas.search_files.parse(args);
            let source: string[] | undefined;
            if (input.respectGitIgnore) {
              try { source = await this.git.listFiles(project, input.path, signal); }
              catch (error) { if (error instanceof AppError && error.code === 'search_source_limit') throw error; }
            }
            return this.files.search(project, input, signal, source);
          }
          case 'edit_block': return this.files.edit(project, toolSchemas.edit_block.parse(args));
          case 'get_file_info': return this.files.info(project, toolSchemas.get_file_info.parse(args).path);
          case 'start_process': return this.processes.start(project, principal.id, toolSchemas.start_process.parse(args), signal, executionAuthorization);
          case 'run_command': return this.processes.run(project, principal.id, toolSchemas.run_command.parse(args), signal, executionAuthorization);
          case 'wait_process': return this.processes.wait(principal.id, project.id, toolSchemas.wait_process.parse(args), signal);
          case 'tail_process_output': return this.processes.tail(principal.id, project.id, toolSchemas.tail_process_output.parse(args));
          case 'read_process_output': return this.processes.read(principal.id, project.id, toolSchemas.read_process_output.parse(args));
          case 'write_process_input': return this.processes.input(principal.id, project.id, toolSchemas.write_process_input.parse(args));
          case 'list_processes': return this.processes.list(principal.id, project.id);
          case 'stop_process': return this.processes.stop(principal.id, project.id, toolSchemas.stop_process.parse(args).processId);
          default: return this.git.invoke(project, tool, args, signal);
        }
      };
      const checkedExecute = async () => { const value = await execute(); guard(); return value; };
      if (toolScope(tool) === 'read' || ['start_process', 'run_command', 'stop_process', 'write_process_input'].includes(tool)) return result(await checkedExecute());
      const prior = this.locks.get(project.id) ?? Promise.resolve();
      const current = prior.catch(() => {}).then(checkedExecute);
      this.locks.set(project.id, current);
      try { return result(await current); }
      finally { if (this.locks.get(project.id) === current) this.locks.delete(project.id); }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'tool_failed';
      return result({ error: code, message: errorText(error), ...(code === 'command_denied' && executionPolicy ? { executionPolicy } : {}), ...(code === 'path_escape' && filesystemPolicy ? { filesystemPolicy } : {}), retryable: ['process_limit', 'git_busy'].includes(code), outcomeUnknown: ['cancelled', 'commit_reconcile_required', 'recovery_required'].includes(code) }, true);
    }
  }
  async close() {
    await this.editor.ready.catch(() => {});
    await Promise.all([...this.locks.values()].map(lock => lock.catch(() => {})));
    await this.git.stopAllAndWait();
    await this.processes.close();
  }
}
