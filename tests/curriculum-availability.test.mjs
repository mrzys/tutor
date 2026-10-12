import test from 'node:test';
import assert from 'node:assert/strict';
import { availableScopeGroups, availableScopeSelection, availableTextbooks } from '../src/curriculum/availability.mjs';

test('range picker unifies original set IDs and stable section IDs, with numeric textbook order', () => {
  const sections = [
    { id: 'rja-compulsory-1:2.3', label: '2.3 二次函数与一元二次方程、不等式' },
    { id: '1.3', label: '1.3 集合的基本运算' },
    { id: 'rja-compulsory-1:1.5', label: '1.5 全称量词与存在量词' },
    { id: 'rja-compulsory-1:2.1', label: '2.1 等式性质与不等式性质' },
    { id: '1.1', label: '1.1 集合的概念' },
    { id: 'rja-compulsory-1:1.4', label: '1.4 充分条件与必要条件' },
    { id: 'rja-compulsory-1:2.2', label: '2.2 基本不等式' },
    { id: '1.2', label: '1.2 集合间的基本关系' },
    { id: 'rja-compulsory-1:4.2', label: '4.2 对数函数' },
    { id: 'rja-compulsory-2:1.1', label: '1.1 任意角' },
    { id: 'rja-compulsory-1:1.1', label: '集合的概念' },
  ];
  const groups = availableScopeGroups(sections);
  assert.deepEqual(groups.map(group => group.label), ['第 1 章 集合与常用逻辑用语', '第 2 章 一元二次函数、方程和不等式']);
  assert.deepEqual(groups.map(group => group.children.map(item => item.label.split(' ')[0])), [['1.1','1.2','1.3','1.4','1.5'],['2.1','2.2','2.3']]);
  assert.equal(sections.length, 11, 'future curriculum remains intact for prerequisite checks');
  assert.deepEqual(availableScopeSelection(sections, ['rja-compulsory-1:1.1','1.1','rja-compulsory-1:4.2']), ['1.1']);
});

test('bank navigation only exposes the first two chapters without mutating full catalogue', () => {
  const books = [{ id: 'rja-compulsory-1', chapters: [
    { id: 'rja-compulsory-1:4', sections: [{ id: 'rja-compulsory-1:4.1' }] },
    { id: 'rja-compulsory-1:2', sections: [{ id: 'rja-compulsory-1:2.3' }, { id: 'rja-compulsory-1:2.1' }] },
    { id: 'rja-compulsory-1:1', sections: [{ id: 'rja-compulsory-1:1.1' }] },
  ] }, { id: 'rja-compulsory-2', chapters: [] }];
  const before = structuredClone(books);
  const open = availableTextbooks(books);
  assert.equal(open.length, 1);
  assert.deepEqual(open[0].chapters.map(chapter => chapter.id), ['rja-compulsory-1:1', 'rja-compulsory-1:2']);
  assert.deepEqual(open[0].chapters[1].sections.map(section => section.id), ['rja-compulsory-1:2.1','rja-compulsory-1:2.3']);
  assert.deepEqual(books, before);
});
