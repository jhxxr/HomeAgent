export const taskStates = [
  { id: 'todo', label: '待办', symbol: '○', hint: '准备好，等待认领' },
  { id: 'in_progress', label: '进行中', symbol: '◉', hint: '正在由客户端执行' },
  { id: 'review', label: '待审核', symbol: '◇', hint: '等待你检查结果' },
  { id: 'done', label: '已完成', symbol: '✓', hint: '留存交付与审核记录' },
];
export const taskState = id => taskStates.find(state => state.id === id) ?? { id, label: id, symbol: '○' };
export function leaseLabel(task, now = Date.now()) {
  if (task.status !== 'in_progress' || !task.leaseExpiresAt) return '';
  const remaining = task.leaseExpiresAt - now;
  return remaining <= 0 ? '租约已到期，等待释放' : `租约剩余 ${Math.ceil(remaining / 60000)} 分钟`;
}
export function relativeTime(at, now = Date.now()) {
  if (!at) return '尚未更新';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return minutes < 1 ? '刚刚更新' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
}
export function parseTargetPaths(value) {
  const paths = [...new Set(value.split(/\r?\n/).map(path => path.trim()).filter(Boolean))];
  if (paths.length > 32 || paths.some(path => path.length > 512)) throw new Error('最多填写 32 个路径，每个路径不超过 512 个字符。');
  return paths;
}
export function taskInstruction(task) {
  const handoff = task.status === 'in_progress'
    ? `任务已分配给 ${task.assignee ?? '认领客户端'}，设备 ${task.assigneeDevice ?? '请确认'}；确认与你的身份和授权一致后继续，不要重复认领。`
    : '若任务为待办，选择已授权设备并通过 kanban_claim_task 认领；其他状态先确认是否允许继续。';
  return `请使用 HomeAgent MCP 处理项目 ${task.projectId} 的任务 ${task.id}「${task.title}」。先调用 kanban_list_tasks 确认最新状态。${handoff}完成后上报实际修改路径、验证结果，并按任务要求提交审核。不要跳过授权或审核。`;
}
export function mergeTaskPage(existing, incoming) {
  const rows = new Map(existing.map(task => [task.id, task]));
  for (const task of incoming) rows.set(task.id, task);
  return [...rows.values()];
}
export function taskPermissions(task, projectAvailable) {
  return { edit: task.status === 'todo' && projectAvailable, release: task.status === 'in_progress', review: task.status === 'review', comment: true };
}
export function dragTransition(from, to) {
  if (from === to) return null;
  const actions = {
    todo: { in_progress: 'assign' },
    in_progress: { todo: 'release', review: 'submit', done: 'finish' },
    review: { todo: 'reject', in_progress: 'revise', done: 'approve' },
    done: { todo: 'reopen', in_progress: 'assign' },
  };
  return actions[from]?.[to] ?? 'invalid';
}

export function fileComparison(task) {
  const expected = new Set(task.targetPaths ?? []), actual = new Set(task.actualPaths ?? []);
  return [...new Set([...expected, ...actual])].map(path => ({ path, expected: expected.has(path), actual: actual.has(path) }));
}
