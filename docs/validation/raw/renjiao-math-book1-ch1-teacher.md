# 练习 · 第一章 本章小结与复习

> 题量：45 题 | 覆盖全章全部知识点

## 知识点覆盖
- [ ] 集合三特性与表示（题 1、2、11、19、27、38）
- [ ] $\in$ / $\notin$ 与常用数集（题 3、12、20、28、39）
- [ ] 子集、真子集、相等（题 4、13、21、29、40）
- [ ] 空集与 $2^n$ 子集计数（题 5、14、22、30、41）
- [ ] 并、交、补运算（题 6、7、15、23、31、42）
- [ ] 德摩根律（题 8、16、24、32、43）
- [ ] 充分、必要、充要条件（题 9、17、25、33、44）
- [ ] 全称量词与存在量词（题 10、18、26、34、45）
- [ ] 量词命题的否定（题 10、18、26、35、45）
- [ ] 含参综合（题 29、30、36、37、40）

---

## A 组 · 基础巩固（18 题）

### 一、选择题（1–8）

**1.** 下列对象能构成集合的是（　）

**解：** C。方程根的全体确定。

---

**2.** 集合 $\{x \in \mathbb{Z} \mid |x| < 3\}$ 用列举法表示为（　）

**解：** A。$\{-2, -1, 0, 1, 2\}$。

---

**3.** 用符号 $\in$ 或 $\notin$ 填空：$\dfrac{3}{5}$ ______ $\mathbb{Q}$；$\sqrt{5}$ ______ $\mathbb{Q}$；$0$ ______ $\mathbb{N}$。

**解：** $\in$；$\notin$；$\in$。

---

**4.** 已知 $A = \{1, 2\}$，$B = \{1, 2, 3\}$，则（　）

**解：** B。$A \subset B$。

---

**5.** 集合 $\{a, b, c, d\}$ 的非空真子集个数为（　）

**解：** A。$2^4 - 2 = 14$。

---

**6.** $A = \{1, 3, 5\}$，$B = \{2, 3, 4\}$，则 $A \cup B = $（　）

**解：** B。

---

**7.** $U = \{1, 2, 3, 4, 5\}$，$A = \{1, 2, 3\}$，则 $\complement_U A = $（　）

**解：** B。$\{4, 5\}$。

---

**8.** $U = \mathbb{R}$，$A = \{x \mid x > 1\}$，$B = \{x \mid x < 3\}$，则 $\complement_U (A \cap B) = $（　）

**解：** A。$A \cap B = (1, 3)$，补集为 $(-\infty, 1] \cup [3, +\infty)$。

---

### 二、填空题（9–14）

**9.** 「若 $x > 3$，则 $x > 1$」中，$x > 3$ 是 $x > 1$ 的 ______ 条件。

**解：** 充分不必要。

---

**10.** 「$\forall x \in \mathbb{R},\, x^2 + x + 1 > 0$」的否定为 ______。

**解：** $\exists x \in \mathbb{R},\, x^2 + x + 1 \le 0$。

---

**11.** 用描述法表示「所有小于 10 的正偶数」：______

**解：** $\{x \in \mathbb{N} \mid x < 10,\, x \text{ 为偶数}\}$ 或 $\{2, 4, 6, 8\}$ 的列举法。

---

**12.** 用符号 $\subseteq$、$\subset$ 或 $=$ 填空：$\varnothing$ ______ $\{0\}$；$\{1, 2\}$ ______ $\{2, 1\}$。

**解：** $\subset$（或 $\subseteq$）；$=$。

---

**13.** $U = \mathbb{R}$，$A = \{x \mid -1 \le x < 3\}$，$B = \{x \mid x \ge 0\}$，则 $A \cap B = $ ______。

**解：** $[0, 3)$。

---

**14.** 命题「$\exists x \in \mathbb{Z},\, x^2 = 3$」的真假为 ______。

**解：** 假。

---

### 三、判断题（15–18）

**15.** 判断正误：（1）$\{0\} = \varnothing$。（　）（2）$\varnothing \subseteq A$ 对任意集合 $A$ 恒成立。（　）

**解：** （1）×；（2）√。

---

**16.** 判断正误：（1）$A \cup B = B \cup A$。（　）（2）$\complement_U (A \cup B) = \complement_U A \cup \complement_U B$。（　）

**解：** （1）√；（2）×。应为 $\cap$。

---

**17.** 判断正误：（1）$p$ 是 $q$ 的充分条件等价于 $q$ 是 $p$ 的必要条件。（　）（2）若 $P \subsetneq Q$，则 $x \in P$ 是 $x \in Q$ 的充分不必要条件。（　）

**解：** （1）√；（2）√。

---

**18.** 判断正误：（1）否定「$\forall$」命题只需加「不」字。（　）（2）「$\exists x \in \mathbb{R},\, x^2 = 2$」是真命题。（　）

**解：** （1）×；（2）√。

---

## B 组 · 综合应用（15 题）

**19.** 若 $A = \{1, a, a^2\}$ 且 $a \ne 1$，求使 $A$ 恰有 3 个元素的 $a$ 的取值范围。

**解：** 排除 $a = 0$（$a = a^2$）、$a = -1$（$a^2 = 1$）、$a = 1$（已知排除）。\
**答案：** $a \in \mathbb{R} \setminus \{-1, 0, 1\}$。

---

**20.** 已知 $A = \{x \mid x^2 - 3x + 2 = 0\}$，$B = \{1, 2, 3\}$，求 $A \cap B$、$A \cup B$，并判断 $A$ 与 $B$ 的关系。

**解：** $A = \{1, 2\}$；$A \cap B = \{1, 2\}$；$A \cup B = \{1, 2, 3\}$；$A \subset B$。

---

**21.** 集合 $\{1, 2, 3\}$ 的所有子集共有 ______ 个；其中含元素 $1$ 的子集有 ______ 个。

**解：** $8$；$4$。

---

**22.** $U = \mathbb{R}$，$A = \{x \mid x^2 - 5x + 6 \le 0\}$，$B = \{x \mid x > m\}$。若 $A \cup B = \mathbb{R}$，求 $m$ 的取值范围。

**解：** $A = [2, 3]$。需 $B = (m, +\infty)$ 覆盖 $(-\infty, 2)$，故 $m < 2$。

---

**23.** $U = \{1, 2, 3, 4, 5\}$，$A = \{1, 3, 5\}$，$B = \{2, 3, 4\}$，求 $\complement_U (A \cap B)$ 和 $\complement_U A \cup \complement_U B$，并验证德摩根律。

**解：** $A \cap B = \{3\}$；$\complement_U (A \cap B) = \{1, 2, 4, 5\}$；$\complement_U A = \{2, 4\}$；$\complement_U B = \{1, 5\}$；$\complement_U A \cup \complement_U B = \{1, 2, 4, 5\}$ ✓。

---

**24.** $U = \mathbb{R}$，$A = \{x \mid |x| < 2\}$，$B = \{x \mid x \ge 1\}$，求 $A \cap B$、$A \cup B$ 及 $\complement_U A$。

**解：** $A \cap B = [1, 2)$；$A \cup B = (-\infty, 2) \cup [1, +\infty) = \mathbb{R}$；$\complement_U A = (-\infty, -2] \cup [2, +\infty)$。

---

**25.** $p$：$x^2 = 4$；$q$：$x = 2$。判断 $p$ 是 $q$ 的什么条件，并用集合观点说明。

**解：** 必要不充分。$P = \{-2, 2\}$，$Q = \{2\}$，$Q \subsetneq P$。

---

**26.** $p$：$x > a$；$q$：$x > 2$。若 $p$ 是 $q$ 的充分不必要条件，求 $a$ 的取值范围。

**解：** $(a, +\infty) \subsetneq (2, +\infty)$，故 $a > 2$。

---

**27.** 写出「$\forall x \in \mathbb{R},\, x^2 \ge x$」的否定，并判断原命题真假。

**解：** 否定：$\exists x \in \mathbb{R},\, x^2 < x$；原命题假（$x = 0.5$ 时 $0.25 < 0.5$）。

---

**28.** 若命题「$\forall x \in [0, 2],\, x^2 - a \ge 0$」为真，求 $a$ 的取值范围。

**解：** $a \le \min_{x \in [0,2]} x^2 = 0$。

---

**29.** 已知 $A = \{x \mid -2 \le x < 4\}$，$B = \{x \mid a \le x \le a + 3\}$，且 $A \cap B = \varnothing$，求 $a$ 的取值范围。

**解：** $a + 3 < -2$ 或 $a \ge 4$，即 $a < -5$ 或 $a \ge 4$。

---

**30.** 已知 $A = \{1, 3\}$，$B = \{x \mid x^2 - 4x + a = 0\}$ 且 $B \subseteq A$，求实数 $a$ 的取值集合。

**解：** $B = \varnothing$（$a > 4$）或 $B = \{1, 3\}$（$a = 3$）。\
**答案：** $\{3\} \cup (4, +\infty)$。

---

**31.** $U = \mathbb{R}$，$A = \{x \mid x^2 - 3x - 4 \le 0\}$，$B = \{x \mid |x - 1| < 2\}$，求 $A \cap B$ 和 $A \cup B$。

**解：** $A = [-1, 4]$，$B = (-1, 3)$；$A \cap B = (-1, 3)$；$A \cup B = [-1, 4]$。

---

**32.** 设 $U = \mathbb{R}$，$A = \{x \mid x < 0\}$，$B = \{x \mid x > 2\}$，用两种方法求 $\complement_U (A \cup B)$。

**解：** 直接法：$A \cup B = (-\infty, 0) \cup (2, +\infty)$，补集 $[0, 2]$。\
德摩根律：$\complement_U A \cap \complement_U B = [0, +\infty) \cap (-\infty, 2] = [0, 2]$。

---

**33.** 下列各组中，$p$ 是 $q$ 的充要条件的是（　）

**解：** D。$x^2 - 4 = 0 \Leftrightarrow |x| = 2$。

---

## C 组 · 拓展提高（12 题）

**34.** 判断下列命题的真假，并写出否定：

（1）$\forall x \in \mathbb{N},\, x^2 \ge x$；\
（2）$\exists x \in \mathbb{R},\, x^2 + 1 < 0$；\
（3）$\forall x \in \mathbb{R},\, \exists y \in \mathbb{R},\, x + y = 1$。

**解：**\
（1）真；否定：$\exists x \in \mathbb{N},\, x^2 < x$（假）。\
（2）假；否定：$\forall x \in \mathbb{R},\, x^2 + 1 \ge 0$（真）。\
（3）真（取 $y = 1 - x$）；否定：$\exists x \in \mathbb{R},\, \forall y \in \mathbb{R},\, x + y \ne 1$（假）。

---

**35.** 写出下列命题的否定：

（1）$\forall x \in \mathbb{R},\, x^2 > 2x$；\
（2）$\exists x \in \mathbb{Z},\, x^2 < x$；\
（3）$\forall x \in \mathbb{R},\, \exists y \in \mathbb{R},\, xy = 0$。

**解：**\
（1）$\exists x \in \mathbb{R},\, x^2 \le 2x$；\
（2）$\forall x \in \mathbb{Z},\, x^2 \ge x$；\
（3）$\exists x \in \mathbb{R},\, \forall y \in \mathbb{R},\, xy \ne 0$。

---

**36.** 已知 $A = \{x \mid x^2 - 3x + 2 = 0\}$，$B = \{x \mid mx - 1 = 0\}$，$C = \{x \mid x^2 - (a+1)x + a = 0\}$。若 $B \subseteq A$ 且 $C \subseteq A$，求 $a$、$m$ 的取值。

**解：** $A = \{1, 2\}$，$C = \{1, a\}$。$C \subseteq A$：$a \in \{1, 2\}$。\
$B \subseteq A$：$m \in \left\{0, 1, \dfrac{1}{2}\right\}$。\
**答案：** $a \in \{1, 2\}$；$m \in \left\{0, 1, \dfrac{1}{2}\right\}$。

---

**37.** $U = \mathbb{R}$，$A = \{x \mid x^2 - 2x - 3 < 0\}$，$B = \{x \mid ax + 1 = 0\}$。若 $B \subseteq A$，求 $a$ 的取值。

**解：** $A = (-1, 3)$。$a = 0$ 或 $-\dfrac{1}{a} \in (-1, 3)$，得 $a < -1$ 或 $a > \dfrac{1}{3}$ 或 $a = 0$。

---

**38.** 用描述法表示「所有个位数字与十位数字之和为 6 的两位正整数」组成的集合，并写出其所有元素。

**解：** $\{10a + b \mid a \in \{1,\ldots,9\},\, b \in \{0,\ldots,9\},\, a + b = 6\}$；$\{15, 24, 33, 42, 51, 60\}$。

---

**39.** 设 $A = \{x \mid x = 2k,\, k \in \mathbb{Z}\}$，$B = \{x \mid x = 4k,\, k \in \mathbb{Z}\}$，$C = \{x \mid x = 3k,\, k \in \mathbb{Z}\}$。判断 $B$ 与 $A$、$A$ 与 $C$ 的包含关系。

**解：** $B \subset A$（$4$ 的倍数是偶数）；$A$ 与 $C$ 无包含关系（$2 \in A$ 但 $2 \notin C$；$3 \in C$ 但 $3 \notin A$）。

---

**40.** 已知 $A = \{x \mid x^2 - 4x + 3 = 0\}$，$B = \{x \mid x^2 - ax + a = 0\}$，$A \cap B = \{3\}$，求 $a$ 并判断「$x \in A$」是「$x \in B$」的什么条件。

**解：** $A = \{1, 3\}$。$3 \in B$：$9 - 3a + a = 0$，$a = \dfrac{9}{2}$。$B = \{3, \dfrac{3}{2}\}$，$A \cap B = \{3\}$ ✓。$P = \{1, 3\}$，$Q = \{3, \dfrac{3}{2}\}$，互不包含，既不充分也不必要。

---

**41.** 若集合 $A$ 有 $n$ 个元素，证明其子集个数为 $2^n$，并求 $\{1, 2, 3, 4, 5\}$ 的恰含 3 个元素的子集个数。

**解：** 每个元素在子集中「取」或「不取」，$2^n$ 种。$\mathrm{C}_5^3 = 10$ 个。

---

**42.** $U = \mathbb{R}$，$A = \{x \mid x < a\}$，$B = \{x \mid x > 1\}$。若 $\complement_U A \subseteq B$，求 $a$ 的取值范围。

**解：** $\complement_U A = [a, +\infty) \subseteq (1, +\infty)$，故 $a > 1$。

---

**43.** 证明：$\complement_U (A \cap B) = (\complement_U A) \cup (\complement_U B)$，并用 $U = \{1,2,3,4\}$，$A = \{1,2\}$，$B = \{2,3\}$ 验证。

**解：** $x \notin A \cap B \Leftrightarrow x \notin A$ 或 $x \notin B$。\
验证：$A \cap B = \{2\}$，$\complement_U (A \cap B) = \{1, 3, 4\}$；$\complement_U A \cup \complement_U B = \{3, 4\} \cup \{1, 4\} = \{1, 3, 4\}$ ✓。

---

**44.** 在 $\triangle ABC$ 中，$p$：$AB = AC$；$q$：$\angle B = \angle C$。判断 $p$ 与 $q$ 的条件关系，并说明理由。

**解：** 充要条件。等腰三角形底角相等，反之底角相等则两边相等。

---

**45.** 设 $p$：$\exists x \in \mathbb{R},\, \forall y \in \mathbb{R},\, x > y$；写出 $p$ 的否定，判断 $p$ 及其否定的真假，并解释「不存在比一切实数都大的实数」的含义。

**解：** 否定：$\forall x \in \mathbb{R},\, \exists y \in \mathbb{R},\, x \le y$。$p$ 假（实数无最大值）；否定真（对任意 $x$ 取 $y = x + 1$）。含义：任何实数都有比它更大的实数，故不存在「最大实数」。
