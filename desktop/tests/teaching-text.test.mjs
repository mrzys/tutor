import test from 'node:test';
import assert from 'node:assert/strict';
import { teachingDisplayText, compactTeachingText } from '../src/teaching-text.ts';
import { mathSegments } from '../src/shared/math-segments.mjs';

test('模型说明中的难度代码以统一中文档位展示，原文不改写', () => {
  const source = '目标难度 medium；相邻档位 easy、easy_medium、medium_hard、hard。';
  assert.equal(teachingDisplayText(source), '目标难度 中等；相邻档位 基础、基础偏中等、中等偏较难、较难。');
  assert.ok(source.includes('medium'));
  assert.equal(teachingDisplayText(null), '');
});

test('简短展示公式随解析文字排版，数学内容与持久化原文不变', () => {
  const raw = String.raw`由题意，\[a^2-2a-3<0\]即\[(a-3)(a+1)<0,\]解得$-1<a<3$。`;
  const before = mathSegments(raw).filter(p=>p.type==='math').map(p=>p.source);
  const view = compactTeachingText(raw);
  assert.equal(mathSegments(view).filter(p=>p.type==='math' && p.displayMode).length, 0);
  assert.deepEqual(mathSegments(view).filter(p=>p.type==='math').map(p=>p.source), before);
  assert.ok(raw.includes('\\['));
});

test('只折合公式附近的单换行，保留段落和原有行内公式', () => {
  assert.equal(compactTeachingText('所以\n$$x>0$$\n解得。\n\n再讨论。'), '所以 \\(x>0\\) 解得。\n\n再讨论。');
  const paragraphs = '第一段。\n \n$$x>0$$\n\n第二段。';
  assert.equal(compactTeachingText(paragraphs), '第一段。\n \n\\(x>0\\)\n\n第二段。');
  assert.equal(compactTeachingText('已有$x+1$与\\(y\\)。'), '已有$x+1$与\\(y\\)。');
});

test('生成稿围住短公式的换行不强制独占一行，实际多行推导仍保留', () => {
  const raw = '令\n$$\n  x=\\frac{\\pi}{3}-\\alpha,\n$$\n则代入原式。';
  const view = compactTeachingText(raw);
  assert.equal(view, '令 \\(x=\\frac{\\pi}{3}-\\alpha,\\) 则代入原式。');
  assert.deepEqual(mathSegments(view).filter(p => p.type === 'math').map(p => p.source.trim()),
    mathSegments(raw).filter(p => p.type === 'math').map(p => p.source.trim()));
  assert.ok(raw.includes('$$\n'));
  const multiline = '$$\n  x=1\n  y=2\n$$';
  assert.equal(compactTeachingText(multiline), multiline);
});

test('多行、矩阵、长推导继续独立展示，图片和表格引用不丢失', () => {
  for (const formula of [String.raw`\[\begin{cases}x=1\\y=2\end{cases}\]`, '$$x=1\ny=2$$', `$$${'x+'.repeat(50)}1$$`]) {
    assert.equal(compactTeachingText(formula), formula);
  }
  const material = '![题图](asset:real-id)\n| A | B |\n|---|---|\n| $x$ | $y$ |';
  assert.equal(compactTeachingText(material), material);
});

test('难度显示转换不改数学区段和非档位英文标识', () => {
  const formula = '$medium+x$ $$easy+y$$ \\(hard+z\\) \\[medium_hard+a\\]';
  assert.equal(teachingDisplayText(formula), formula);
  assert.equal(teachingDisplayText('harder、medium_value、Hardy'), 'harder、medium_value、Hardy');
});

test('待核对候选的难度依据仍使用中文名称，不因候选状态泄漏内部档位', () => {
  const candidateBasis = '题目给出新定义，需要将“等分周长”落实为圆周交点成对径；各步方法常规但含实质关口，故定为 medium_hard。';
  assert.equal(teachingDisplayText(candidateBasis), '题目给出新定义，需要将“等分周长”落实为圆周交点成对径；各步方法常规但含实质关口，故定为 中等偏较难。');
  assert.ok(candidateBasis.endsWith('medium_hard。'));
});

test('候选考查文本仅转换已知档位，未知档位及带身份前后缀的标识保持原样', () => {
  const candidate = '难度 medium_hard；原条件 $x_{medium_hard}>0$。future_hard、medium_hard_v2、question_medium_hard、difficulty_unknown 保留。';
  assert.equal(teachingDisplayText(candidate), '难度 中等偏较难；原条件 $x_{medium_hard}>0$。future_hard、medium_hard_v2、question_medium_hard、difficulty_unknown 保留。');
  assert.equal(teachingDisplayText('medium_hardish'), 'medium_hardish');
});
