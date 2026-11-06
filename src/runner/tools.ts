import type { ExecutionPolicy, FilesystemPolicy } from '../shared/effective-permissions.js';
import path from 'node:path';
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
import { Shells } from './shells.js';
import { Lsp } from './lsp.js';
import { Memory, resolveWorkspacePath } from './memory.js';

/** Serialize each project's mutations so expected hashes and moves are meaningful across concurrent clients. */
export class Tools {
  readonly policy: Policy; readonly files: Files; readonly processes: Processes; readonly git: Git;
  readonly editor: Editor; readonly context: Context; readonly shells: Shells; readonly lsp: Lsp;
  readonly memory: Memory;
  private locks = new Map<string, Promise<unknown>>();
  constructor(config: RunnerConfig, private deviceId?: string, private consent?: AssistConsent) {
    this.policy = new Policy(config, consent); this.files = new Files(this.policy); this.processes = new Processes(config, this.policy); this.git = new Git(this.policy);
    this.editor = new Editor(config, this.files);
    const configDir = config.stateDir ? path.dirname(config.stateDir) : undefined;
    this.memory = new Memory(resolveWorkspacePath(configDir));
    this.context = new Context(config, this.files, this.git, this.processes, this.memory);
    this.shells = new Shells(this.policy, this.processes); this.lsp = new Lsp(this.policy, this.files, this.git);
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
          case 'read_files': {
            const input = toolSchemas.read_files.parse(args);
            const output = await this.files.readFiles(project, input);
            const hints = await this.memory.match(project.id, input.files.map(f => f.path)).catch(() => []);
            return hints.length ? { ...output, memoryHints: hints } : output;
          }
          case 'edit_files': {
            const input = toolSchemas.edit_files.parse(args);
            const output = await this.editor.edit(project, principal.id, input.changes, input.dryRun, signal);
            const hints = await this.memory.match(project.id, input.changes.map(c => c.path)).catch(() => []);
            return hints.length ? { ...output, memoryHints: hints } : output;
          }
          case 'apply_unified_diff': {
            const input = toolSchemas.apply_unified_diff.parse(args);
            const parsed = await parseUnifiedDiff(this.files, project, input.diff, input.expectedSha256, { fuzz: input.fuzz, ignoreWhitespace: input.ignoreWhitespace });
            const output = { ...await this.editor.edit(project, principal.id, parsed, input.dryRun, signal), relocatedHunks: parsed.relocatedHunks };
            const hints = await this.memory.match(project.id, Object.keys(input.expectedSha256)).catch(() => []);
            return hints.length ? { ...output, memoryHints: hints } : output;
          }
          case 'get_edit_transactions': return this.editor.list(project, principal.id);
          case 'recover_edit_transaction': return this.editor.recover(project, principal.id, toolSchemas.recover_edit_transaction.parse(args).transactionId);
          case 'list_directory': return this.files.list(project, toolSchemas.list_directory.parse(args));
          case 'read_file': {
            const input = toolSchemas.read_file.parse(args);
            const output = await this.files.read(project, input);
            const hints = await this.memory.match(project.id, [input.path]).catch(() => []);
            return hints.length ? { ...output, memoryHints: hints } : output;
          }
          case 'write_file': {
            const input = toolSchemas.write_file.parse(args);
            const output = await this.files.write(project, input);
            const hints = await this.memory.match(project.id, [input.path]).catch(() => []);
            return hints.length ? { ...output, memoryHints: hints } : output;
          }
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
          case 'edit_block': {
            const input = toolSchemas.edit_block.parse(args);
            const output = await this.files.edit(project, input);
            const hints = await this.memory.match(project.id, [input.path]).catch(() => []);
            return hints.length ? { ...output, memoryHints: hints } : output;
          }
          case 'get_file_info': return this.files.info(project, toolSchemas.get_file_info.parse(args).path);
          case 'start_process': return this.processes.start(project, principal.id, toolSchemas.start_process.parse(args), signal, executionAuthorization);
          case 'run_command': return this.processes.run(project, principal.id, toolSchemas.run_command.parse(args), signal, executionAuthorization);
          case 'wait_process': return this.processes.wait(principal.id, project.id, toolSchemas.wait_process.parse(args), signal);
          case 'tail_process_output': return this.processes.tail(principal.id, project.id, toolSchemas.tail_process_output.parse(args));
          case 'read_process_output': return this.processes.read(principal.id, project.id, toolSchemas.read_process_output.parse(args));
          case 'write_process_input': return this.processes.input(principal.id, project.id, toolSchemas.write_process_input.parse(args));
          case 'list_processes': return this.processes.list(principal.id, project.id);
          case 'stop_process': return this.processes.stop(principal.id, project.id, toolSchemas.stop_process.parse(args).processId);
          case 'start_shell': return this.shells.start(project, principal.id, toolSchemas.start_shell.parse(args), signal, executionAuthorization);
          case 'run_shell': return this.shells.run(project, principal.id, toolSchemas.run_shell.parse(args), signal, executionAuthorization);
          case 'list_shells': return this.shells.list(principal.id, project.id);
          case 'stop_shell': return this.shells.stop(principal.id, project.id, toolSchemas.stop_shell.parse(args).sessionId);
          case 'lsp_document_symbols': return this.lsp.documentSymbols(project, toolSchemas.lsp_document_symbols.parse(args));
          case 'lsp_workspace_symbols': return this.lsp.workspaceSymbols(project, toolSchemas.lsp_workspace_symbols.parse(args), signal);
          case 'lsp_definition': return this.lsp.definition(project, toolSchemas.lsp_definition.parse(args), signal);
          case 'lsp_references': return this.lsp.references(project, toolSchemas.lsp_references.parse(args), signal);
          case 'lsp_hover': return this.lsp.hover(project, toolSchemas.lsp_hover.parse(args), signal);
          case 'lsp_diagnostics': return this.lsp.diagnostics(project, principal, toolSchemas.lsp_diagnostics.parse(args), signal);
          default: return this.git.invoke(project, tool, args, signal);
        }
      };
      const checkedExecute = async () => { const value = await execute(); guard(); return value; };
      if (toolScope(tool) === 'read' || ['start_process', 'run_command', 'stop_process', 'write_process_input', 'start_shell', 'run_shell', 'stop_shell'].includes(tool)) return result(await checkedExecute());
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
