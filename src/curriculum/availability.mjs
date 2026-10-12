// MVP navigation policy. Keep the complete curriculum in storage for prerequisite checks.
const textbookId = 'rja-compulsory-1';
const openChapters = [
  { id: `${textbookId}:1`, number: '1', title: '集合与常用逻辑用语' },
  { id: `${textbookId}:2`, number: '2', title: '一元二次函数、方程和不等式' },
];
const compareNumber = (a, b) => String(a.number || a.id.split(':').at(-1))
  .localeCompare(String(b.number || b.id.split(':').at(-1)), 'zh-CN', { numeric: true });

export function availableTextbooks(textbooks = []) {
  return textbooks.filter(book => book.id === textbookId).map(book => ({
    ...book,
    chapters: book.chapters.filter(chapter => openChapters.some(open => open.id === chapter.id))
      .toSorted(compareNumber).map(chapter => ({ ...chapter, sections: chapter.sections.toSorted(compareNumber) })),
  }));
}

export function availableScopeGroups(sections = []) {
  const unique = new Map();
  for (const section of sections) {
    const id = section.textbookSectionId || section.id;
    const canonical = ['1.1', '1.2', '1.3'].includes(id) ? `${textbookId}:${id}` : id;
    // Old task presets still reference the short IDs. Display each physical section once.
    if (!unique.has(canonical) || ['1.1', '1.2', '1.3'].includes(section.id)) unique.set(canonical, section);
  }
  return openChapters.map(chapter => ({
    ...chapter,
    label: `第 ${chapter.number} 章 ${chapter.title}`,
    children: [...unique.values()].filter(section => {
      const sectionId = section.textbookSectionId || section.id;
      // The original three set sections used short IDs; preserve their identities.
      return sectionId.startsWith(`${chapter.id}.`)
        || (chapter.number === '1' && ['1.1', '1.2', '1.3'].includes(sectionId));
    }).toSorted(compareNumber).map(section => {
      const number = (section.textbookSectionId || section.id).split(':').at(-1);
      return { ...section, label: section.label.startsWith(`${number} `) ? section.label : `${number} ${section.label}` };
    }),
  })).filter(chapter => chapter.children.length);
}

export function availableScopeSelection(sections, selected = []) {
  const choices = availableScopeGroups(sections).flatMap(group => group.children);
  return [...new Set(selected.map(id => choices.find(section => section.id === id
    || (['1.1','1.2','1.3'].includes(section.id) && id === `${textbookId}:${section.id}`))?.id).filter(Boolean))];
}
