import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { errorMessage } from './errors';
import { useToast } from '@/components/ui/toast';

/**
 * 写操作的统一入口。三个 feature 里的 mutation 都走它，好处是：
 * 失败一定会弹 Toast（10.4）、成功一定会失效对应查询，不会出现「拖完了列没动」。
 *
 * 用法：
 *   const move = useApiMutation(
 *     (vars: { id: string; to: TaskStatus }) => api.tasks.transition(vars.id, { to: vars.to }),
 *     { invalidate: () => [qk.boardRoot, qk.tasksRoot] },
 *   );
 *   move.mutate({ id, to });
 */
export interface ApiMutationOptions<TVars, TData> {
  /** 成功后失效：常量数组，或按响应/入参算出 key 列表的函数。 */
  invalidate?:
    | readonly QueryKey[]
    | ((context: { vars: TVars; data: TData }) => readonly QueryKey[]);
  /** 默认弹错误 Toast；表单自己内联显示错误时给 false。 */
  toastOnError?: boolean;
  /** 自定义错误文案（默认用服务端 message，见 api/errors.ts）。 */
  errorText?: (error: unknown) => string;
  onSuccess?: (data: TData, vars: TVars) => void;
  onSettled?: (data: TData | undefined, error: unknown, vars: TVars) => void;
}

export function useApiMutation<TVars = void, TData = unknown>(
  mutationFn: (vars: TVars) => Promise<TData>,
  options: ApiMutationOptions<TVars, TData> = {},
) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { invalidate, toastOnError = true, errorText, onSuccess, onSettled } = options;

  return useMutation<TData, Error, TVars>({
    mutationFn,
    onSuccess: (data, vars) => {
      if (invalidate) {
        const keys = typeof invalidate === 'function' ? invalidate({ vars, data }) : invalidate;
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      }
      onSuccess?.(data, vars);
    },
    onError: (error) => {
      if (toastOnError) {
        const text = errorText
          ? errorText(error)
          : errorMessage(error);
        toast.error(text);
      }
    },
    onSettled,
  });
}
