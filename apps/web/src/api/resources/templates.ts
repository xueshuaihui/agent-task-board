import { http } from '../client';
import type { Template, TemplateCreateInput, TemplatePatchInput } from '../types';

/** 13 章「模板接口」。 */
export const templatesApi = {
  list: () => http.get<{ items: Template[] }>('/templates'),
  create: (body: TemplateCreateInput) => http.post<Template>('/templates', body),
  patch: (id: string, body: TemplatePatchInput) =>
    http.patch<Template>(`/templates/${enc(id)}`, body),
  remove: (id: string) => http.del<{ id: string }>(`/templates/${enc(id)}`),
};

function enc(value: string): string {
  return encodeURIComponent(value);
}
