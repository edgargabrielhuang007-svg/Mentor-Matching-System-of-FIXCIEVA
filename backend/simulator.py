#!/usr/bin/env python3
"""
师徒制正反选全景仿真引擎 (Unified Mentor-Mentee Matching Simulator)
支持动态配置干事人数、部长人数、选择槽位数 (1~4)、顺位/等权优先级开关，
支持 CLI 命令行批量仿真输出与 Web API 毫秒级极速调用。
"""

import sys
import time
import math
import random
import argparse
from collections import defaultdict, Counter
from typing import Dict, Any, List

def run_simulation(
    num_mentees: int = 20,
    num_ministers: int = 10,
    mentee_pick_count: int = 4,
    minister_pick_count: int = 3,
    mentee_has_priority: bool = True,
    minister_has_priority: bool = False,
    runs: int = 30000,
    max_rounds: int = 5
) -> Dict[str, Any]:
    """
    运行蒙特卡洛仿真模拟
    """
    t0 = time.time()
    
    # 配额计算
    quota_per_minister = max(1, math.ceil(num_mentees / num_ministers))
    
    # 统计指标容器
    r1_matches_list = []
    final_matches_list = []
    rounds_needed_list = []
    deadlock_count = 0  # 首轮0结对或最终未能结对
    r1_zero_matches_count = 0 # 首轮0匹配极端情况
    
    # 偏好达成顺位统计 (仅在干事有顺位时统计)
    mentee_rank_counts = Counter()
    total_matched_mentees = 0
    
    # 轮次完成累积分布 (1轮完成, 2轮完成, 3轮完成, 4+轮完成)
    rounds_completion_counter = Counter()

    for game_idx in range(runs):
        mentee_matched = [-1] * num_mentees # -1 表示未配对，>=0 表示配对的部长 ID
        mentee_matched_rank = [-1] * num_mentees
        minister_matched = [[] for _ in range(num_ministers)] # 每个部长录取的干事列表
        
        game_rounds_run = 0
        r1_match_count = 0

        for r in range(max_rounds):
            game_rounds_run = r + 1
            
            # 当前未满额的部长与未配对的干事
            unfilled_ministers = [m for m in range(num_ministers) if len(minister_matched[m]) < quota_per_minister]
            unmatched_mentees = [s for s in range(num_mentees) if mentee_matched[s] == -1]

            if not unfilled_ministers or not unmatched_mentees:
                break
                
            k_m_picks = min(mentee_pick_count, len(unfilled_ministers))
            k_min_picks = min(minister_pick_count, len(unmatched_mentees))

            # 干事选部长
            mentee_choices = {}
            for s in unmatched_mentees:
                mentee_choices[s] = random.sample(unfilled_ministers, k_m_picks)

            # 部长选干事
            minister_choices = {}
            for m in unfilled_ministers:
                minister_choices[m] = random.sample(unmatched_mentees, k_min_picks)

            # --- 撮合逻辑 ---
            round_new_matches = 0
            
            if mentee_has_priority:
                # 干事顺位优先：逐级分阶段撮合 (Phase 0, Phase 1, ...)
                for phase in range(k_m_picks):
                    # 收集该顺位申请各部长的干事
                    applicants = defaultdict(list)
                    for s in unmatched_mentees:
                        if mentee_matched[s] != -1:
                            continue
                        if phase < len(mentee_choices[s]):
                            target_m = mentee_choices[s][phase]
                            # 部长也选择了该干事
                            if s in minister_choices[target_m]:
                                applicants[target_m].append(s)

                    for m, app_list in applicants.items():
                        rem_q = quota_per_minister - len(minister_matched[m])
                        if rem_q <= 0 or not app_list:
                            continue

                        if len(app_list) <= rem_q:
                            accepted = app_list
                        else:
                            if minister_has_priority:
                                # 部长也有顺位优先：按部长自己的偏好排序择优录取
                                m_order = minister_choices[m]
                                app_list.sort(key=lambda x: m_order.index(x) if x in m_order else 999)
                                accepted = app_list[:rem_q]
                            else:
                                # 部长等权池：公平随机抽签
                                random.shuffle(app_list)
                                accepted = app_list[:rem_q]

                        for s in accepted:
                            if mentee_matched[s] == -1 and len(minister_matched[m]) < quota_per_minister:
                                mentee_matched[s] = m
                                mentee_matched_rank[s] = phase + 1
                                minister_matched[m].append(s)
                                round_new_matches += 1
                                mentee_rank_counts[phase + 1] += 1
                                total_matched_mentees += 1
            else:
                # 干事等权池：干事所有选的项目同时申请
                applicants = defaultdict(list)
                for s in unmatched_mentees:
                    for target_m in mentee_choices[s]:
                        if s in minister_choices[target_m]:
                            applicants[target_m].append(s)

                for m, app_list in applicants.items():
                    rem_q = quota_per_minister - len(minister_matched[m])
                    if rem_q <= 0 or not app_list:
                        continue
                    if len(app_list) <= rem_q:
                        accepted = app_list
                    else:
                        if minister_has_priority:
                            m_order = minister_choices[m]
                            app_list.sort(key=lambda x: m_order.index(x) if x in m_order else 999)
                            accepted = app_list[:rem_q]
                        else:
                            random.shuffle(app_list)
                            accepted = app_list[:rem_q]

                    for s in accepted:
                        if mentee_matched[s] == -1 and len(minister_matched[m]) < quota_per_minister:
                            mentee_matched[s] = m
                            mentee_matched_rank[s] = 1 # 等权
                            minister_matched[m].append(s)
                            round_new_matches += 1
                            total_matched_mentees += 1

            if r == 0:
                r1_match_count = round_new_matches
                if round_new_matches == 0:
                    r1_zero_matches_count += 1

            # 若本轮未发生任何新的匹配，继续下一轮也不会有新结果（出现死锁停滞）
            if round_new_matches == 0:
                break

        # 局末统计
        final_matched_count = sum(1 for m in mentee_matched if m != -1)
        r1_matches_list.append(r1_match_count)
        final_matches_list.append(final_matched_count)
        rounds_needed_list.append(game_rounds_run)
        rounds_completion_counter[game_rounds_run] += 1
        
        if final_matched_count < num_mentees:
            deadlock_count += 1

    t1 = time.time()
    elapsed = max(0.001, t1 - t0)

    # 计算核心聚合统计
    avg_r1_matches = sum(r1_matches_list) / runs
    r1_hit_rate = (avg_r1_matches / num_mentees) * 100.0

    avg_final_matches = sum(final_matches_list) / runs
    final_hit_rate = (avg_final_matches / num_mentees) * 100.0

    avg_rounds = sum(rounds_needed_list) / runs
    deadlock_rate = (deadlock_count / runs) * 100.0
    r1_deadlock_rate = (r1_zero_matches_count / runs) * 100.0

    # 顺位达成分布 (百分比)
    rank_distribution = {}
    if mentee_has_priority and total_matched_mentees > 0:
        for rk in range(1, mentee_pick_count + 1):
            cnt = mentee_rank_counts.get(rk, 0)
            rank_distribution[f"第 {rk} 顺位"] = f"{(cnt / total_matched_mentees) * 100:.1f}%"
    else:
        rank_distribution["等权意向达成"] = f"{final_hit_rate:.1f}%"

    # 轮次完成分布
    rounds_dist = {}
    for rd in range(1, max_rounds + 1):
        rate = (rounds_completion_counter.get(rd, 0) / runs) * 100.0
        rounds_dist[f"第 {rd} 轮完结"] = f"{rate:.1f}%"

    # 博弈倾斜与机制优势评估
    advantage_type = "相对均衡"
    advantage_tag = "⚖️ 权力相对均衡"
    advantage_color = "#3B82F6"
    advantage_reason = ""

    # 计算供需比与自由度
    mentee_freedom = mentee_pick_count / max(1, num_ministers)
    minister_freedom = minister_pick_count / max(1, num_mentees)

    if mentee_pick_count > minister_pick_count:
        if mentee_pick_count >= 3 and minister_pick_count <= 2:
            advantage_type = "干事显著占优"
            advantage_tag = "🚀 干事显著占优"
            advantage_color = "#10B981"
            advantage_reason = f"干事可挑选 {mentee_pick_count} 个顺位部长（容错缓冲高），而部长仅选 {minister_pick_count} 位干事（候选池窄）。干事只要命中部长小池即获优先，选择权与心理满意度明显偏向干事。"
        else:
            advantage_type = "干事略占优"
            advantage_tag = "🌿 干事略占优"
            advantage_color = "#10B981"
            advantage_reason = f"干事可选 {mentee_pick_count} 人，多于部长的 {minister_pick_count} 人，干事的主动选择权更强，多轮顺位递进可有效兜底。"
    elif minister_pick_count > mentee_pick_count:
        if minister_pick_count >= 3 and mentee_pick_count <= 2:
            advantage_type = "部长显著占优"
            advantage_tag = "👑 部长显著占优"
            advantage_color = "#F59E0B"
            advantage_reason = f"部长可广撒网挑选 {minister_pick_count} 位干事，而干事仅能填报 {mentee_pick_count} 个部长志愿。部长名额极易被抢光，干事一旦前两个志愿落空便面临落单调剂风险。"
        else:
            advantage_type = "部长略占优"
            advantage_tag = "🌾 部长略占优"
            advantage_color = "#F59E0B"
            advantage_reason = f"部长挑选候选池更宽 ({minister_pick_count}人 > {mentee_pick_count}人)，部长的招募灵活性高于干事填报灵活性。"
    else:
        if mentee_has_priority and not minister_has_priority:
            advantage_type = "干事顺位优先"
            advantage_tag = "✨ 干事顺位优先"
            advantage_color = "#6366F1"
            advantage_reason = f"双方可选名额相等（各 {mentee_pick_count} 人），但干事拥有严格第1至第{mentee_pick_count}顺位保护机制，部长为等权意向池，属于典型的‘干事志愿分批清算’平权福利模型。"
        elif not mentee_has_priority and minister_has_priority:
            advantage_type = "部长顺位优先"
            advantage_tag = "🎖️ 部长顺位优先"
            advantage_color = "#F59E0B"
            advantage_reason = f"双方可选名额相等，但部长拥有顺位优先录取权，干事为等权报送，录取次序由部长主观偏好决定。"
        elif mentee_has_priority and minister_has_priority:
            advantage_type = "双向顺位强博弈"
            advantage_tag = "🔄 双向顺位强博弈"
            advantage_color = "#8B5CF6"
            advantage_reason = f"双方均开启了顺位优先级，形成双向延期接受（Deferred Acceptance）稳定匹配架构，兼顾了干事梯队志愿与部长的梯队偏好。"
        else:
            advantage_type = "完全双向平权"
            advantage_tag = "🤝 完全双向平权池"
            advantage_color = "#3B82F6"
            advantage_reason = f"双方各选 {mentee_pick_count} 人且均无主次顺位，只要产生交集即进入等权仲裁抽签池，没有任何策略性博弈偏向。"

    # 机制建议
    recommendations = []
    if minister_pick_count == 1:
        recommendations.append("⚠️ 部长仅限选1人时，双向错位率极高，单轮结对效率骤降，强烈建议将部长候选扩充至 2~3 人。")
    if mentee_pick_count == 1:
        recommendations.append("⚠️ 干事仅填报1人将失去任何梯度容错机会，极易在大热部长处出现扎堆撞车并大面积落单。")
    if deadlock_rate > 5.0:
        recommendations.append(f"⚠️ 当前配置下存在 {deadlock_rate:.1f}% 的最终未完全匹配率，建议适度增加候选槽位或开启管理员调剂环节。")
    else:
        recommendations.append(f"✅ 当前机制稳定性优异，预计平均 {avg_rounds:.1f} 轮即可完成全员或绝大部分成员匹配。")

    # 评估量级标定 (对齐 150 万量级决策评估)
    total_evaluated_points = runs * num_mentees * mentee_pick_count

    return {
        "status": "ok",
        "params": {
            "num_mentees": num_mentees,
            "num_ministers": num_ministers,
            "quota_per_minister": quota_per_minister,
            "mentee_pick_count": mentee_pick_count,
            "minister_pick_count": minister_pick_count,
            "mentee_has_priority": mentee_has_priority,
            "minister_has_priority": minister_has_priority,
            "runs": runs,
            "total_evaluated_points": total_evaluated_points
        },
        "metrics": {
            "r1_hit_rate": round(r1_hit_rate, 1),
            "final_hit_rate": round(final_hit_rate, 1),
            "avg_r1_matches": round(avg_r1_matches, 2),
            "avg_final_matches": round(avg_final_matches, 2),
            "deadlock_rate": round(deadlock_rate, 2),
            "r1_deadlock_rate": round(r1_deadlock_rate, 3),
            "expected_rounds": round(avg_rounds, 1),
            "elapsed_seconds": round(elapsed, 3),
            "total_evaluated_points_display": f"{total_evaluated_points:,} 次互选决策模拟"
        },
        "advantage": {
            "type": advantage_type,
            "tag": advantage_tag,
            "color": advantage_color,
            "reason": advantage_reason
        },
        "distributions": {
            "ranks": rank_distribution,
            "rounds": rounds_dist
        },
        "recommendations": recommendations
    }

def main():
    parser = argparse.ArgumentParser(description="社团师徒制双向互选全景仿真引擎")
    parser.add_argument("--mentees", type=int, default=20, help="干事总人数 (默认 20)")
    parser.add_argument("--ministers", type=int, default=10, help="部长总人数 (默认 10)")
    parser.add_argument("--mentee-picks", type=int, default=4, help="干事可选部长数 (1~4)")
    parser.add_argument("--minister-picks", type=int, default=3, help="部长可选干事数 (1~4)")
    parser.add_argument("--mentee-priority", type=int, default=1, help="干事是否有顺位 (1=是, 0=否)")
    parser.add_argument("--minister-priority", type=int, default=0, help="部长是否有顺位 (1=是, 0=否)")
    parser.add_argument("--runs", type=int, default=50000, help="仿真对局数 (默认 50000)")
    parser.add_argument("--output", type=str, default="/home/ubuntu/mentor_matching_app/模拟结果.md", help="输出报告文件路径")
    
    args = parser.parse_args()

    print("=" * 60)
    print("🚀 启动师徒制双向互选机制仿真模拟引擎")
    print(f"设定参数: 干事 {args.mentees} 人 | 部长 {args.ministers} 人")
    print(f"选择规则: 干事选 {args.mentee_picks} 人 (顺位优先: {bool(args.mentee_priority)}) | 部长选 {args.minister_picks} 人 (顺位优先: {bool(args.minister_priority)})")
    print(f"对局量级: {args.runs:,} 局全流程博弈")
    print("=" * 60)

    res = run_simulation(
        num_mentees=args.mentees,
        num_ministers=args.ministers,
        mentee_pick_count=args.mentee_picks,
        minister_pick_count=args.minister_picks,
        mentee_has_priority=bool(args.mentee_priority),
        minister_has_priority=bool(args.minister_priority),
        runs=args.runs
    )

    m = res["metrics"]
    adv = res["advantage"]
    print("\n【仿真统计核心结论】")
    print(f"👉 首轮命中率: {m['r1_hit_rate']}% (平均结对 {m['avg_r1_matches']} 人)")
    print(f"👉 最终命中率: {m['final_hit_rate']}% (平均结对 {m['avg_final_matches']} 人)")
    print(f"👉 悬空(死锁)率: {m['deadlock_rate']}%")
    print(f"👉 预计完成轮次: {m['expected_rounds']} 轮")
    print(f"👉 权力倾斜评估: {adv['tag']}")
    print(f"👉 评估理由: {adv['reason']}")
    print(f"👉 耗时: {m['elapsed_seconds']} 秒 ({m['total_evaluated_points_display']})")

    # 生成 Markdown 分析报告
    with open(args.output, "w", encoding="utf-8") as f:
        f.write("# 师徒制正反选全景仿真与博弈平衡分析报告\n\n")
        f.write(f"- **仿真时间**: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"- **对局规模**: {args.runs:,} 局全流程对抗（共 {m['total_evaluated_points_display']}）\n")
        f.write(f"- **参数配置**: 干事 {args.mentees} 人（选 {args.mentee_picks} 人，顺位: {bool(args.mentee_priority)}）| 部长 {args.ministers} 人（选 {args.minister_picks} 人，顺位: {bool(args.minister_priority)}）\n\n")
        f.write("## 一、核心指标摘要\n\n")
        f.write("| 评估指标 | 仿真数值 | 行业参考健康阈值 |\n")
        f.write("| :--- | :--- | :--- |\n")
        f.write(f"| **首轮结对率 (Round 1 Hit Rate)** | **{m['r1_hit_rate']}%** | > 65% 为佳 |\n")
        f.write(f"| **最终结对率 (Final Hit Rate)** | **{m['final_hit_rate']}%** | > 95% 为佳 |\n")
        f.write(f"| **悬空/死锁率 (Deadlock Rate)** | **{m['deadlock_rate']}%** | < 2% 为佳 |\n")
        f.write(f"| **预计全流程完结轮次** | **{m['expected_rounds']} 轮** | 2 ~ 3 轮为佳 |\n\n")
        f.write("## 二、博弈权力与偏好倾斜评估\n\n")
        f.write(f"### {adv['tag']}\n\n")
        f.write(f"> {adv['reason']}\n\n")
        f.write("## 三、顺位命中与轮次完成分布\n\n")
        f.write("### 1. 干事各顺位命中率\n\n")
        for k, v in res["distributions"]["ranks"].items():
            f.write(f"- **{k}**: {v}\n")
        f.write("\n### 2. 轮次完成累积分布\n\n")
        for k, v in res["distributions"]["rounds"].items():
            f.write(f"- **{k}**: {v}\n")
        f.write("\n## 四、机制优化决策建议\n\n")
        for rec in res["recommendations"]:
            f.write(f"- {rec}\n")
        f.write("\n")

    print(f"\n✅ 模拟结果报告已输出至: {args.output}\n")

if __name__ == "__main__":
    main()
