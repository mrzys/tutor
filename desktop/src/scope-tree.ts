export type ScopeNode = {
  key: string;
  label: string;
  kind: "book" | "chapter" | "section";
  scopeId?: string;
  selectableIds: string[];
  children: ScopeNode[];
};

// Only the original three set presets have documented short identities.
export function canonicalScope(id: string): string {
  return ["1.1", "1.2", "1.3"].includes(id) ? `rja-compulsory-1:${id}` : id;
}

export function scopeNodes(catalog: any, chapters: any[] = [], tasks: any[] = []): ScopeNode[] {
  const taskScopes = new Set<string>(tasks.flatMap(task => (task.sectionIds || []).map(canonicalScope)));
  const available = new Map<string, string>();
  for (const item of chapters) {
    const uid = canonicalScope(item.textbookSectionId || item.id);
    if (taskScopes.has(uid) && !available.has(uid)) available.set(uid, item.id);
  }
  const branch = (key: string, label: string, kind: ScopeNode["kind"], children: ScopeNode[]): ScopeNode => ({
    key, label, kind, children, selectableIds: children.flatMap(child => child.selectableIds),
  });
  return (catalog?.textbooks || []).map((book: any) => branch(`book:${book.id}`, book.title || book.volume || book.id, "book",
    (book.chapters || []).map((chapter: any) => branch(`chapter:${chapter.id}`, chapter.title || chapter.label || chapter.id, "chapter",
      (chapter.sections || []).map((section: any): ScopeNode => {
        const scopeId = available.get(canonicalScope(section.id));
        const number = section.number || section.id.split(":").at(-1);
        const title = section.title || section.label || section.id;
        return { key: `section:${section.id}`, label: title.startsWith(`${number} `) ? title : `${number} ${title}`, kind: "section", scopeId, selectableIds: scopeId ? [scopeId] : [], children: [] };
      }),
    )),
  ));
}

export function filterScopeNodes(nodes: ScopeNode[], query: string): ScopeNode[] {
  const value = query.trim().toLocaleLowerCase();
  if (!value) return nodes;
  return nodes.flatMap(node => {
    if (node.label.toLocaleLowerCase().includes(value)) return [node];
    const children = filterScopeNodes(node.children, value);
    return children.length ? [{ ...node, children, selectableIds: children.flatMap(child => child.selectableIds) }] : [];
  });
}

export function scopeCheckState(ids: string[], selected: string[]) {
  const current = new Set(selected.map(canonicalScope));
  const count = ids.filter(id => current.has(canonicalScope(id))).length;
  return { count, checked: ids.length > 0 && count === ids.length, mixed: count > 0 && count < ids.length };
}

export function toggleScopes(selected: string[], ids: string[], checked: boolean): string[] {
  const targets = new Set(ids.map(canonicalScope));
  if (!checked) return selected.filter(id => !targets.has(canonicalScope(id)));
  const present = new Set(selected.map(canonicalScope));
  return [...selected, ...ids.filter(id => { const uid = canonicalScope(id); if (present.has(uid)) return false; present.add(uid); return true; })];
}
