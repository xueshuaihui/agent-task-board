# 依赖图（feature/dependency-graph）

任务依赖图可视化（docs/0919/1.md §6.2、docs/0919/2.md 第八章）。纯新增 feature，
不改任何现有文件；SVG 手绘分层布局，未引入 react-flow / d3 等图库。

## 文件

| 文件 | 职责 |
|---|---|
| `layout.ts` | 纯函数 DAG 分层布局（Kahn 最长路径分层；环边不计入分层，环上节点兜底到最后一层并标 `inCycle`） |
| `DependencyGraphCanvas.tsx` | SVG 画布：滚轮缩放（50%–200%）、拖拽平移、适应屏幕、节点/边渲染与点击事件 |
| `DependencyGraphDialog.tsx` | 入口弹窗：添加/删除依赖（带确认）、图例、`onOpenTask` 回调接缝 |
| `useDependencyGraph.ts` | 数据层：逐任务拉 `/tasks/{id}/dependencies` 并并成边集（复用 `api.tasks.*` 与 `qk.taskDependencies`），增删 mutation（复用 `useApiMutation`） |

## 挂载入口

### 1. 任务详情抽屉「依赖」Tab（1.md 6.2 / 2.md 7.7）

在 `features/task-detail` 的依赖 Tab（或其工具条）加一个按钮，打开全量依赖图，
并以当前任务所属需求做过滤：

```tsx
import { DependencyGraphDialog } from '@/features/dependency-graph';
import { useBoard } from '@/api'; // 或已有任务数据源

const [graphOpen, setGraphOpen] = useState(false);
const board = useBoard();
const tasks = useMemo(
  () => board.data?.columns.flatMap((column) => column.tasks) ?? [],
  [board.data],
);

<Button size="sm" onClick={() => setGraphOpen(true)}>依赖图</Button>

<DependencyGraphDialog
  open={graphOpen}
  onClose={() => setGraphOpen(false)}
  tasks={tasks}
  requirementId={task.requirement_id /* DTO 若无此字段则传 null */}
  onOpenTask={(taskId) => {
    setGraphOpen(false);
    openTaskDrawer(taskId); // 接现有抽屉打开逻辑
  }}
/>
```

### 2. 看板工具栏「依赖图」（2.md 8.1 全局依赖图）

在 `features/board/toolbar.tsx` 右侧加按钮，`requirementId` 不传即全局图：

```tsx
<DependencyGraphDialog
  open={open}
  onClose={() => setOpen(false)}
  tasks={boardTasks}          // board 六列 flatMap
  onOpenTask={openTaskDrawer}
/>
```

## 数据契约

- `GraphTask`：`TaskCard` / `TaskListItem` / `TaskDetail` 都满足（id/title/status/priority/progress）。
  需求过滤依赖任务对象上的 `requirement_id` 字段；当前 DTO 未带该字段时，由调用方
  预过滤好再传 `tasks`，`requirementId` 仅用于标题展示也可传 `null`。
- 边方向：`from` = 前置任务（`depends_on` 指向的），`to` = 依赖它的任务；箭头指向下游。
- 删除依赖用的是**依赖行 id**（`DependencyRef.dep_id`），不是任务 id（20.3）。
- 环检测在后端（添加依赖 409 拒绝，文案直接 Toast）；前端只在历史脏数据出现环时做布局兜底。

## 设计 token

颜色全部走 `styles/globals.css` 的 `@theme` token（`fill-status-*`、`stroke-border-strong`、
`fill-priority-*` 等），节点卡片 180×72（2.md 8.3），未新增任何色值。
