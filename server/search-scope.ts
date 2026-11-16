import { z } from "zod";
import { searchSchema } from "../shared/schema.js";

export const searchScopeSchema = searchSchema.pick({
  category: true,
  view: true,
  tag: true,
  before: true,
  after: true,
});
export type SearchScope = z.output<typeof searchScopeSchema>;
export function searchScope(input: z.output<typeof searchSchema>): SearchScope {
  const { category, view, tag, before, after } = input;
  return { category, view, tag, before, after };
}
// These SQL fragments contain only fixed expressions. Every external value is
// bound, and every source join must also include s.owner=i.owner.
export function scopeFilter(owner: string, scope: SearchScope) {
  const params: unknown[] = [owner];
  const where = ["i.owner=$1"];
  const add = (expression: string, value: unknown) => {
    params.push(value);
    where.push(expression.replace("?", `$${params.length}`));
  };
  if (scope.category) add("lower(i.category)=lower(?)", scope.category);
  where.push(
    scope.view === "Trash"
      ? "i.trashed_at IS NOT NULL AND i.trashed_at > clock_timestamp()-interval '7 days'"
      : "i.trashed_at IS NULL",
  );
  if (scope.view === "Saved") where.push("i.is_saved=true");
  if (scope.tag) add("?=ANY(i.tags)", scope.tag.toLowerCase());
  if (scope.before) add("i.created_at<?", scope.before);
  if (scope.after) add("i.created_at>?", scope.after);
  return { params, filtered: where.join(" AND ") };
}

export const literalPattern = (term: string) =>
  `%${term.replace(/[!%_]/g, "!$&")}%`;
