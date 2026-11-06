import test from 'node:test';
import assert from 'node:assert/strict';
import { taskStates, leaseLabel, relativeTime, parseTargetPaths, taskInstruction, mergeTaskPage, taskPermissions, fileComparison, dragTransition } from '../public/kanban-model.js';
import { dashboard } from '../src/server/dashboard.js';

test('Kanban navigation and accessible forms are shipped in the actual dashboard', () => {
  assert.match(dashboard, /data-console-view="kanban"/);
  for (const id of ['kbCreate', 'kbProject', 'kbColumns', 'kbRows', 'kbTaskDialog', 'kbEditForm', 'kbCommentForm', 'kbConflict']) assert.ok(dashboard.includes(`id="${id}"`));
  assert.match(dashboard, /执行与输出/);
  assert.match(dashboard, /aria-labelledby="kbTaskTitle"/);
  assert.match(dashboard, /\/assets\/kanban.css/);
});

test('task states and lease labels convey explicit state without inferred progress', () => {
  assert.deepEqual(taskStates.map(state => state.id), ['todo', 'in_progress', 'review', 'done']);
  assert.equal(leaseLabel({ status: 'todo', leaseExpiresAt: 120001 }, 1), '');
  assert.equal(leaseLabel({ status: 'in_progress', leaseExpiresAt: 120001 }, 1), '租约剩余 2 分钟');
  assert.equal(leaseLabel({ status: 'in_progress', leaseExpiresAt: 1 }, 2), '租约已到期，等待释放');
  assert.equal(relativeTime(120000, 120001), '刚刚更新');
  assert.equal(relativeTime(60000, 120001), '1 分钟前');
});

test('target paths are deduplicated and bounded before submitting a task', () => {
  assert.deepEqual(parseTargetPaths(' src/a.ts\r\nsrc/b.ts\n\nsrc/a.ts '), ['src/a.ts', 'src/b.ts']);
  assert.throws(() => parseTargetPaths('a'.repeat(513)));
  assert.throws(() => parseTargetPaths(Array.from({ length: 33 }, (_, i) => `${i}`).join('\n')));
});

test('page merging retains unique tasks and detail controls follow server states', () => {
  assert.deepEqual(mergeTaskPage([{ id: 'a', revision: 1 }, { id: 'b' }], [{ id: 'a', revision: 2 }, { id: 'c' }]), [{ id: 'a', revision: 2 }, { id: 'b' }, { id: 'c' }]);
  assert.equal(taskPermissions({ status: 'todo' }, false).edit, false);
  assert.equal(taskPermissions({ status: 'todo' }, true).edit, true);
  assert.equal(taskPermissions({ status: 'in_progress' }, true).release, true);
  assert.equal(taskPermissions({ status: 'done' }, true).review, false);
  assert.equal(taskPermissions({ status: 'review' }, false).review, true);
});

test('file comparison exposes unexpected changes and task instructions retain exact project IDs', () => {
  assert.deepEqual(fileComparison({ targetPaths: ['a', 'b'], actualPaths: ['b', 'c'] }), [
    { path: 'a', expected: true, actual: false }, { path: 'b', expected: true, actual: true }, { path: 'c', expected: false, actual: true },
  ]);
  const instruction = taskInstruction({ id: 'TASK-001', projectId: 'same-name-different-id', title: '<script>not html</script>' });
  assert.ok(instruction.includes('same-name-different-id'));
  assert.ok(instruction.includes('kanban_claim_task'));
  assert.ok(instruction.includes('不要跳过授权或审核'));
});

test('drag transitions map to explicit validated actions rather than arbitrary status writes', () => {
  assert.equal(dragTransition('todo', 'in_progress'), 'assign');
  assert.equal(dragTransition('todo', 'done'), 'invalid');
  assert.equal(dragTransition('in_progress', 'review'), 'submit');
  assert.equal(dragTransition('in_progress', 'done'), 'finish');
  assert.equal(dragTransition('review', 'done'), 'approve');
  assert.equal(dragTransition('review', 'in_progress'), 'revise');
  assert.equal(dragTransition('review', 'todo'), 'reject');
  assert.equal(dragTransition('done', 'todo'), 'reopen');
  assert.equal(dragTransition('done', 'in_progress'), 'assign');
  assert.equal(dragTransition('todo', 'todo'), null);
});
