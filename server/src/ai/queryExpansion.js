/**
 * 查询扩展（Query Expansion）
 * ---------------------------------------------------------------------------
 * 用户口语提问往往与知识库用词不一致（例如「膝盖疼」vs 库里的「膝关节不适」），
 * 直接 BM25 检索容易跑偏。这里用一张「同义词 / 上下位词」映射表做轻量查询扩展，
 * 显著提升中文小知识库的召回质量，且完全可控、可解释。
 *
 * 为什么单独抽成一个模块：
 *   教练对话（coachAgent）、计划生成（planAgent）和检索实验室（/api/rag/explain）都要用同一套
 *   扩展规则。放在一个文件里，评审可以在页面上直接看到「你这句问题被扩展成了哪些词、命中了哪条规则」，
 *   而不是只能在对话结果里猜。
 */
export const QUERY_EXPANSION = {
  膝盖: '膝关节 关节不适 低冲击 替代动作',
  膝: '膝关节 关节不适',
  腰: '腰部 腰痛 核心稳定 脊柱中立',
  肩: '肩关节 肩袖 过头推举',
  疼: '疼痛 不适 替代动作 安全',
  伤: '损伤 禁忌 替代动作 安全',
  减脂: '热量缺口 有氧 燃脂 饮食 蛋白质',
  减肥: '减脂 热量缺口 有氧',
  增肌: '增肌 抗阻 蛋白质 渐进超负荷',
  塑形: '塑形 体脂 力量 线条',
  酸痛: 'DOMS 延迟性肌肉酸痛 恢复',
  蛋白: '蛋白质 摄入 分配 训练后',
  吃: '饮食 营养 配餐 热量',
  睡: '睡眠 恢复 过度训练',
  平台: '平台期 突破 代谢适应',
  高血压: '高血压 安全 禁忌 有氧',
  孕期: '孕期 产后 安全',
  新手: '新手 入门 4周 进阶',
  心率: '心率区间 Z2 强度',
};

/**
 * 命中哪些扩展规则、拼出来的检索串长什么样
 * @param {string} question 用户原始提问
 * @returns {{ expanded: string, appliedRules: Array<{trigger:string, expansion:string}> }}
 */
export function expandQueryDetailed(question = '') {
  const appliedRules = [];
  for (const [trigger, expansion] of Object.entries(QUERY_EXPANSION)) {
    if (question.includes(trigger)) appliedRules.push({ trigger, expansion });
  }
  const expanded = [question, ...appliedRules.map((r) => r.expansion)].join(' ');
  return { expanded, appliedRules };
}

/** 只要扩展后的检索串（对话/计划生成用） */
export function expandQuery(question = '') {
  return expandQueryDetailed(question).expanded;
}
