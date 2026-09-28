import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import type { TaskCreateInput, TaskStatus, TemplatePreset } from '@/api/types';
import { errorMessage, fieldErrorsOf, isApiError, useFieldDefs, useSettings } from '@/api';
import {
  requirementCreateBody,
  useRequirementOptions,
  type RequirementOption,
} from '@/features/requirements/use-requirement-options';
// 走 hooks 子路径而不是 `@/features/skills` 桶口：桶口会连带引出 skill-library-page，
// 后者回头 import app/router 的路由候选，而 router 的 ROUTES 又来自这个桶口——
// vitest 下这条环会让 ROUTES 项在求值时还是 undefined（真机靠打包顺序侥幸）。
import { useSkills } from '@/features/skills/hooks';
import { SkillPickerPopover } from '@/features/skills/skill-picker';
import { useFilterStore } from '@/app/store/filters';
import { priorityText, STATUS_LABEL } from '@/lib/labels';
import { clearFieldError } from '@/lib/forms';
import { useToast } from '@/components/ui';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import type { BoardMutations } from './mutations';
import { cardDefs, CustomFieldInputs, requiredDefs, toSubmitValues, type CustomValues } from './custom-fields';

/**
 * 3.1 / 8.1 的列底快速新建：需求池与待执行两列的入口，加上已完成卡片的「新建后续任务」。
 *
 * 四条硬规则：
 * - 服务端 `create` 恒落 `BACKLOG`（20.2 默认值 + 8.1「不自动跳到待执行」），
 *   所以「建在待执行」= create → transition(READY) 两步；
 * - 必填自定义字段未填 → 服务端 422，任务留在需求池，`details[]` 按字段逐条回显（6.9.2）；
 * - 已建行的第二次提交走 PATCH + transition，不再 create 一遍（避免重复卡片）；
 * - 技能可在建时就绑（10.2）：`skills` 随 create 一起提交，服务端在落库前校验，
 *   坏引用 422 回显在「技能」字段下、不会留下没挂技能的半成品。
 *
 * 3.4 的模板只作为**预填**（类型/优先级/标签/描述/自定义字段/到期），
 * 标题仍由人写——模板若连标题一起填死，一列里会出现同名卡片。
 */
export interface QuickCreateTarget {
  target: TaskStatus;
  /** 4.3.1 规则 6：`DONE` 重做时把原任务设为新任务的前置。 */
  dependsOn?: { id: string; title: string };
  /** 3.4：模板预填值。 */
  preset?: TemplatePreset;
}

export interface QuickCreateDialogProps {
  state: QuickCreateTarget | null;
  mutations: BoardMutations;
  onClose: () => void;
}

export function QuickCreateDialog({ state, mutations, onClose }: QuickCreateDialogProps) {
  // 退场动画接线（统一套路）：ref 保留末次非空 state + open 受控——变 null 时不卸载，
  // Dialog 经历 true→false 过渡帧播 140ms 退场，表单仍是刚才那份。
  const lastStateRef = useRef<QuickCreateTarget | null>(null);
  if (state) lastStateRef.current = state;
  const shown = state ?? lastStateRef.current;
  // 每次真正打开（false→true）递增 key 重挂表单：输入与已建行 id 回到初始态（与旧条件挂载等价）。
  const wasOpenRef = useRef(false);
  const sessionRef = useRef(0);
  if (state && !wasOpenRef.current) sessionRef.current += 1;
  wasOpenRef.current = Boolean(state);
  if (!shown) return null;
  return (
    <QuickCreateForm
      // 每次换目标列/换前置都重挂一份，表单状态自然复位；会话号保证重开同一目标也是干净表单。
      key={`${shown.target}-${shown.dependsOn?.id ?? 'none'}-s${sessionRef.current}`}
      state={shown}
      open={Boolean(state)}
      mutations={mutations}
      onClose={onClose}
    />
  );
}

interface QuickCreateFormProps {
  state: QuickCreateTarget;
  /** 受控开关：false 时 Dialog 播退场而不是被卸载。 */
  open: boolean;
  mutations: BoardMutations;
  onClose: () => void;
}

function QuickCreateForm({ state, open, mutations, onClose }: QuickCreateFormProps) {
  const toast = useToast();
  const settings = useSettings();
  const fieldDefs = useFieldDefs();
  const types = settings.data?.task_types ?? ['需求'];
  const defaults = fieldDefs.data?.items ?? [];
  const preset = state.preset;

  // 6.11 的「标题前缀」也是预填值：写进输入框而不是提交时拼接，用户能看见也能改（原型 8.1）。
  const [title, setTitle] = useState(preset?.title_prefix ?? '');
  const [description, setDescription] = useState(preset?.description ?? '');
  const [type, setType] = useState(
    preset?.type && types.includes(preset.type) ? preset.type : (types[0] ?? '需求'),
  );
  const [priority, setPriority] = useState(String(preset?.priority ?? 3));
  const [tagText, setTagText] = useState((preset?.tags ?? []).join(', '));
  const [custom, setCustom] = useState<CustomValues>(preset?.custom_fields ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [createdId, setCreatedId] = useState<string | null>(null);
  // 10.2 创建即绑定：技能一次性全量在手（§9.11 匹配纯前端本地），候选排除 ARCHIVED，
  // 草稿与已发布都可选（服务端按绑定版本下发，10.1 未限制草稿）。
  const skills = useSkills();
  const skillItems = useMemo(() => skills.data?.items ?? [], [skills.data?.items]);
  const skillCandidates = useMemo(
    () => skillItems.filter((skill) => skill.status !== 'ARCHIVED'),
    [skillItems],
  );
  const [skillIds, setSkillIds] = useState<string[]>([]);

  // §19.14·86（W2-a）：创建时的唯一归属选择是「需求」——选中即同写 parent_task_id +
  // 回填该需求的 group_id（Group 概念已从看板 UI 下线，不再直接选它）。
  // 默认值取看板需求筛选「恰好只选了一个需求」的场景，其他情况留空（不选）——
  // 归属是弱约束，不该在快速新建里替用户做主。
  const requirementOptions = useRequirementOptions();
  const filterRequirements = useFilterStore((state) => state.requirements);
  const [requirementId, setRequirementId] = useState(() =>
    defaultRequirementId(filterRequirements),
  );

  const defs = useMemo(() => defaults.filter((def) => def.enabled), [defaults]);
  const required = useMemo(() => requiredDefs(defs, type), [defs, type]);
  const optional = useMemo(() => cardDefs(defs, type), [defs, type]);
  const busy = mutations.create.isPending || mutations.advance.isPending || mutations.patch.isPending;

  const selectedRequirement = useMemo<RequirementOption | null>(
    () => requirementOptions.data.find((option) => option.id === requirementId) ?? null,
    [requirementOptions.data, requirementId],
  );

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setErrors({});
    const customFields = toSubmitValues([...required, ...optional], custom);

    try {
      let id = createdId;
      if (id === null) {
        const body: TaskCreateInput = {
          title: title.trim(),
          type,
          priority: Number(priority),
          custom_fields: customFields,
          tags: parseTags(tagText),
        };
        if (description.trim()) body.description = description.trim();
        // 版本一律不传：服务端补当前有效版本（与详情「技能」Tab 同一口径）。
        if (skillIds.length) body.skills = skillIds.map((skill_id) => ({ skill_id }));
        // §19.14·86：选需求 → 同写 parent_task_id + 回填 group_id；未选 → 两字段都不发。
        Object.assign(body, requirementCreateBody(selectedRequirement));
        if (preset?.required_capabilities?.length) body.required_capabilities = preset.required_capabilities;
        if (typeof preset?.due_offset_days === 'number' && preset.due_offset_days > 0) {
          body.due_at = new Date(Date.now() + preset.due_offset_days * 86_400_000).toISOString();
        }
        if (state.dependsOn) {
          body.depends_on = [state.dependsOn.id];
          body.dependency_type = 'blocks';
        }
        const created = await mutations.create.mutateAsync(body);
        id = created.id;
        setCreatedId(id);
      } else {
        // 上一轮已建行、只是必填字段没填够：补值用 PATCH，不重复创建。
        await mutations.patch.mutateAsync({ id, body: { custom_fields: customFields } });
      }

      if (state.target === 'READY') await mutations.advance.mutateAsync(id);
      toast.success(`已创建 ${id}`, `落在「${STATUS_LABEL[state.target]}」`);
      onClose();
    } catch (error) {
      handleFailure(error, toast, setErrors);
    }
  };

  return (
    <Dialog
      open={open}
      size="form"
      title={state.dependsOn ? `新建后续任务（前置 ${state.dependsOn.id}）` : `新建任务 → ${STATUS_LABEL[state.target]}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {createdId ? '补填并继续' : state.target === 'READY' ? '创建并进待执行' : '创建'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={submit}
        onKeyDown={(event: KeyboardEvent) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit();
        }}
      >
        <Field label="标题" required error={errors.title}>
          <Input
            value={title}
            invalid={Boolean(errors.title)}
            autoFocus
            maxLength={200}
            placeholder="一句话说清要做什么"
            onChange={(event) => {
              setTitle(event.target.value);
              clearFieldError(setErrors, 'title');
            }}
          />
        </Field>

        <Field label="描述" hint="Markdown，仅用于详情抽屉" error={errors.description}>
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              clearFieldError(setErrors, 'description');
            }}
            invalid={Boolean(errors.description)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="类型" required error={errors.type}>
            <Select
              value={type}
              invalid={Boolean(errors.type)}
              options={types.map((item) => ({ value: item, label: item }))}
              onChange={(event) => {
                setType(event.target.value);
                clearFieldError(setErrors, 'type');
              }}
            />
          </Field>
          <Field label="优先级" required error={errors.priority}>
            <Select
              value={priority}
              options={[0, 1, 2, 3].map((value) => ({ value: String(value), label: priorityText(value) }))}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
        </div>

        <Field label="需求" hint="可选；选中后自动跟随该需求的归属（§19.14）">
          <Select
            value={requirementId}
            placeholder="未分配需求"
            options={requirementOptions.data.map((option) => ({
              value: option.id,
              label: option.title,
            }))}
            onChange={(event) => setRequirementId(event.target.value)}
          />
        </Field>

        <Field label="标签" hint="逗号分隔，单个 ≤ 16 字、最多 10 个（20.3）" error={errors.tags}>
          <Input
            value={tagText}
            placeholder="后端, 缺陷修复"
            onChange={(event) => {
              setTagText(event.target.value);
              clearFieldError(setErrors, 'tags');
            }}
          />
        </Field>

        {/* 10.2 创建即绑定：候选区必须是共享 SkillPicker（§19.13-83），形态同拆解草案
            ——多选、选中后面板不关、点击已选项做增删切换；已选 chips 挂在触发器左侧。 */}
        <Field
          label="技能"
          hint="可选；随任务下发给领取的 Agent（10.3），建完仍可在详情「技能」Tab 增删"
          error={errors.skills}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {skillIds.map((id) => {
              const name = skillItems.find((item) => item.id === id)?.name ?? id;
              return (
                <span
                  key={id}
                  className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-control bg-bg-muted px-1.5 py-0.5 text-aux text-text-primary"
                >
                  <span className="truncate">{name}</span>
                  <button
                    type="button"
                    aria-label={`移除技能 ${name}`}
                    className="shrink-0 text-text-tertiary hover:text-text-primary"
                    onClick={() => setSkillIds((prev) => prev.filter((item) => item !== id))}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              );
            })}
            <SkillPickerPopover
              multiple
              candidates={skillCandidates}
              selectedIds={skillIds}
              disambiguateOver={skillItems}
              onSelect={(skill) =>
                setSkillIds((prev) =>
                  prev.includes(skill.id)
                    ? prev.filter((item) => item !== skill.id)
                    : [...prev, skill.id],
                )
              }
              disabled={skills.isPending || skillCandidates.length === 0}
              emptyText={skills.isPending ? '技能加载中…' : '没有可添加的技能'}
              placeholder="搜索技能（名称 / 分类 / 类型 / 标签 / ID，草稿与已发布）"
              ariaLabel="创建时绑定技能"
              triggerContent={() => (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-aux text-text-secondary"
                  data-testid="quick-create-skill-add"
                >
                  <Plus className="size-3.5" aria-hidden />
                  添加技能
                </span>
              )}
            />
          </div>
        </Field>

        {state.dependsOn ? (
          <p className="text-aux text-text-secondary">
            前置依赖：<span className="font-mono">{state.dependsOn.id}</span> {state.dependsOn.title}
            <span className="ml-1 text-text-tertiary">（blocks，5.1）</span>
          </p>
        ) : null}

        {required.length + optional.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <p className="text-aux text-text-tertiary">自定义字段</p>
            <CustomFieldInputs
              defs={[...required, ...optional]}
              values={custom}
              errors={pickCustomErrors(errors)}
              onChange={(key, value) => {
                setCustom((current) => ({ ...current, [key]: value }));
                clearFieldError(setErrors, `custom_fields.${key}`);
              }}
            />
          </div>
        ) : null}

        {state.target === 'READY' ? (
          <p className="text-aux text-text-tertiary">
            创建后会立刻流转到「待执行」；必填字段未填时服务端会拒绝该流转，任务留在需求池。
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * §19.14·86 的默认归属规则：看板「需求」筛选恰好只选 1 个时默认挂该需求，
 * 否则不选（不替用户做主）。纯函数供单测直钉。
 */
export function defaultRequirementId(filterRequirements: readonly string[]): string {
  return filterRequirements.length === 1 ? filterRequirements[0]! : '';
}

/** 20.3：标签去重、去首尾空白、单个 ≤ 16 字、每任务 ≤ 10 个。 */
function parseTags(text: string): string[] {
  const parts = text
    .split(/[,，\s]+/)
    .map((item) => item.trim().slice(0, 16))
    .filter(Boolean);
  return [...new Set(parts)].slice(0, 10);
}

/** 服务端 `details[].path` 形如 `custom_fields.severity`，拆成卡片内联错误。 */
function pickCustomErrors(errors: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    if (!path.startsWith('custom_fields.')) continue;
    result[path.slice('custom_fields.'.length)] = message;
  }
  return result;
}

/** 只有 `VALIDATION_FAILED` 需要逐字段内联回显（6.9.2）；其余错误由 Toast 说一句话。 */
function handleFailure(
  error: unknown,
  toast: ReturnType<typeof useToast>,
  setErrors: (errors: Record<string, string>) => void,
): void {
  const issues = fieldErrorsOf(error);
  if (isApiError(error) && error.code === 'VALIDATION_FAILED') {
    setErrors(issues);
    toast.warning(error.message, Object.values(issues).slice(0, 3).join('；'));
    return;
  }
  toast.error(errorMessage(error));
}
