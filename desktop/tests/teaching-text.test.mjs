import test from 'node:test';
import assert from 'node:assert/strict';
import { teachingDisplayText } from '../src/teaching-text.ts';

test('模型说明中的难度代码以统一中文档位展示，原文不改写', () => {
  const source = '目标难度 medium；相邻档位 easy、easy_medium、medium_hard、hard。';
  assert.equal(teachingDisplayText(source), '目标难度 中等；相邻档位 基础、基础偏中等、中等偏较难、较难。');
  assert.ok(source.includes('medium'));
  assert.equal(teachingDisplayText(null), '');
});

test('难度显示转换不改数学区段和非档位英文标识', () => {
  const formula = '$medium+x$ $$easy+y$$ \\(hard+z\\) \\[medium_hard+a\\]';
  assert.equal(teachingDisplayText(formula), formula);
  assert.equal(teachingDisplayText('harder、medium_value、Hardy'), 'harder、medium_value、Hardy');
});
