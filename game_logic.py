# -*- coding: utf-8 -*-
"""狼人杀「传手机法官」纯逻辑层。

不依赖 Kivy / 任何图形库，可独立运行与测试。
UI 层(main.py)只负责把这里的数据渲染成按钮和文字。

基本玩法：一部手机在玩家之间传递，App 充当法官。
设置人数与板子 -> 发牌(逐人私密查看) -> 夜晚各角色依次拿手机行动
-> 天亮公布死亡 -> 白天投票出局 -> 循环至分出胜负。
"""

import base64
import pickle
import random

# ---------------------------------------------------------------- 角色常量
WEREWOLF = "werewolf"   # 狼人
VILLAGER = "villager"   # 村民
SEER = "seer"           # 预言家
WITCH = "witch"         # 女巫
GUARD = "guard"         # 守卫
HUNTER = "hunter"       # 猎人
HALFBLOOD = "halfblood"  # 混血儿

ROLE_NAME = {
    WEREWOLF: "狼人",
    VILLAGER: "村民",
    SEER: "预言家",
    WITCH: "女巫",
    GUARD: "守卫",
    HUNTER: "猎人",
    HALFBLOOD: "混血儿",
}

# 好人阵营的神民
GOD_ROLES = (SEER, WITCH, GUARD, HUNTER)

# 屠边局中占「民坑」的角色(混血儿按平民计算)
VILLAGER_ROLES = (VILLAGER, HALFBLOOD)

# 死因
CAUSE_WOLF = "wolf"      # 被狼人杀害
CAUSE_POISON = "poison"  # 被女巫毒死(不能开枪)
CAUSE_VOTE = "vote"      # 白天被投出局
CAUSE_SHOOT = "shoot"    # 被猎人带走
CAUSE_MANUAL = "manual"  # 主持人手动出局

CAUSE_NAME = {
    CAUSE_WOLF: "被狼人杀害",
    CAUSE_POISON: "被女巫毒死",
    CAUSE_VOTE: "被投票出局",
    CAUSE_SHOOT: "被猎人开枪带走",
}

# ---------------------------------------------------------------- 板子预设
# 人数 -> 身份牌堆(发牌时会被随机洗牌)
BOARDS = {
    6:  [WEREWOLF] * 2 + [VILLAGER] * 3 + [SEER],
    7:  [WEREWOLF] * 2 + [VILLAGER] * 4 + [SEER],
    8:  [WEREWOLF] * 3 + [VILLAGER] * 4 + [SEER],
    9:  [WEREWOLF] * 3 + [VILLAGER] * 3 + [SEER, WITCH, HUNTER],
    10: [WEREWOLF] * 3 + [VILLAGER] * 4 + [SEER, WITCH, HUNTER],
    11: [WEREWOLF] * 4 + [VILLAGER] * 4 + [SEER, WITCH, HUNTER],
    12: [WEREWOLF] * 4 + [VILLAGER] * 4 + [SEER, WITCH, HUNTER, GUARD],
}

SUPPORTED_COUNTS = sorted(BOARDS.keys())

# 自定义板子：各身份可填的数量范围(神职每种最多1，与夜晚流程兼容)
ROLE_ORDER = (WEREWOLF, VILLAGER, SEER, WITCH, GUARD, HUNTER, HALFBLOOD)
ROLE_LIMITS = {
    WEREWOLF: (1, 8),
    VILLAGER: (0, 15),
    SEER: (0, 1),
    WITCH: (0, 1),
    GUARD: (0, 1),
    HUNTER: (0, 1),
    HALFBLOOD: (0, 1),
}


def board_summary(count_or_roles):
    """返回板子的中文说明，如 '4狼 4民 预女猎守'。

    参数可以是预设人数(int)或自定义身份列表(list)。
    """
    if isinstance(count_or_roles, int):
        roles = BOARDS[count_or_roles]
    else:
        roles = list(count_or_roles)
    wolf = roles.count(WEREWOLF)
    vill = roles.count(VILLAGER)
    gods = [r for r in (SEER, WITCH, HUNTER, GUARD) if r in roles]
    god_names = {SEER: "预言家", WITCH: "女巫", HUNTER: "猎人", GUARD: "守卫"}
    parts = ["%d狼" % wolf, "%d民" % vill]
    if gods:
        parts.append("".join(god_names[r] for r in gods))
    if HALFBLOOD in roles:
        parts.append("混血")
    return "  ".join(parts)


# ---------------------------------------------------------------- 数据模型
class Player(object):
    def __init__(self, seat, name, role):
        self.seat = seat          # 座位号，1 起
        self.name = name          # 玩家昵称
        self.role = role          # 角色常量
        self.alive = True         # 是否存活
        self.death_cause = None   # 死因，见 CAUSE_*

    @property
    def is_god(self):
        return self.role in GOD_ROLES

    @property
    def is_wolf(self):
        return self.role == WEREWOLF

    @property
    def is_halfblood(self):
        return self.role == HALFBLOOD

    def label(self):
        return "%d号 %s" % (self.seat, self.name)


class NightAction(object):
    """某一个夜晚里各角色的行动记录，每晚开始时重置。"""
    def __init__(self):
        self.guard_target = None          # 守卫守护的座位，None=空守
        self.wolf_target = None           # 狼人击杀的座位，None=空刀
        self.witch_heal = False           # 女巫是否使用解药
        self.witch_poison_target = None   # 女巫毒杀的座位，None=不用毒
        self.seer_target = None           # 预言家查验的座位
        self.hunter_shoot_target = None   # 猎人在夜晚阶段决定开枪的目标
        self.seer_is_wolf = False         # 查验结果
        self.halfblood_target = None      # 混血儿首夜选择的榜样座位


class GameState(object):
    def __init__(self, players):
        self.players = players            # List[Player]
        self.day = 1                      # 当前是第几天/第几夜
        self.witch_heal_used = False
        self.witch_poison_used = False
        # 猎人开枪资格是否已永久结算(开过枪/放弃/被毒)。结算前猎人每晚
        # 都作为最后一个行动出现，避免用"是否沉默"泄露猎人死活。
        self.hunter_resolved = False
        self.last_guard_target = None     # 上一晚守卫守护的座位(不能连守)
        self.night = NightAction()
        self.last_night_deaths = []       # [(seat, cause)]
        self.winner = None                # None / 'good' / 'wolf'
        # 胜利条件：'bian'=屠边(杀光神或杀光民)，'cheng'=屠城(杀光所有好人)
        self.win_rule = "bian"
        # 开局神/民数量(setup_game 会覆写)，用于自定义板子的屠边判定
        self.init_gods = 1
        self.init_villagers = 1
        # 女巫毒药是否可用：8 人以下对局只有解药，没有毒药
        self.poison_enabled = True
        # 混血儿首夜选定的榜样座位(持久保存，夜晚记录每晚重置)
        self.halfblood_target = None
        self.log = []

    # ---- 便捷查询 ----
    def player(self, seat):
        return self.players[seat - 1]

    def alive_players(self):
        return [p for p in self.players if p.alive]

    def players_with_role(self, role):
        return [p for p in self.players if p.role == role]

    def alive_role(self, role):
        return [p for p in self.players if p.role == role and p.alive]

    def witch(self):
        w = self.players_with_role(WITCH)
        return w[0] if w else None

    def halfblood(self):
        hb = self.players_with_role(HALFBLOOD)
        return hb[0] if hb else None

    def heal_available(self):
        w = self.witch()
        return bool(w and w.alive and not self.witch_heal_used)

    def poison_available(self):
        # 8 人以下对局没有毒药；毒药全程仅一瓶
        w = self.witch()
        return bool(self.poison_enabled and w and w.alive
                    and not self.witch_poison_used)


# ---------------------------------------------------------------- 开局发牌
def setup_game(names, roles=None, seed=None, win_rule="bian"):
    """发牌开局。

    names: 玩家昵称列表，座位号按列表顺序 1..N。
    roles: 自定义身份列表(长度须与 names 一致)；为 None 时按 BOARDS 预设。
    win_rule: 'bian'=屠边(默认)，'cheng'=屠城。
    返回一个已随机分配好身份的 GameState。
    """
    count = len(names)
    if roles is None:
        if count not in BOARDS:
            raise ValueError("不支持的玩家人数：%r" % count)
        deck = list(BOARDS[count])
    else:
        deck = list(roles)
        if len(deck) != count:
            raise ValueError("身份数(%d)与玩家数(%d)不一致"
                             % (len(deck), count))
    rng = random.Random(seed)
    rng.shuffle(deck)
    players = [
        Player(seat=i + 1, name=names[i], role=deck[i])
        for i in range(count)
    ]
    state = GameState(players)
    # 记录开局时的神/民数量，供屠边判定适配自定义板子(如无神局)
    # 混血儿在屠边局中占民坑
    state.init_gods = sum(1 for r in deck if r in GOD_ROLES)
    state.init_villagers = sum(1 for r in deck if r in VILLAGER_ROLES)
    # 8 人以下对局：女巫只有解药，没有毒药
    state.poison_enabled = count >= 8
    state.win_rule = win_rule
    state.log.append("游戏开始，共 %d 人：%s（%s）" % (
        count, board_summary(deck), "屠城局" if win_rule == "cheng" else "屠边局"))
    return state


def start_night(state):
    """进入新的一夜，重置行动记录。"""
    state.night = NightAction()


# ---------------------------------------------------------------- 夜晚流程
# 夜晚阶段类型：
#   handoff      交接屏(请把手机交给某个角色)，不含任何保密信息
#   select       选择一个目标座位(可附带 skip_label 表示可放弃)
#   witch_heal   女巫决定是否使用解药
#   seer_result  预言家查验结果
#   end          夜晚结束
class NightFlow(object):
    """驱动「一个夜晚」的线性状态机，UI 按 stages 顺序渲染。"""

    def __init__(self, state):
        self.state = state
        self.cursor = 0
        self.stages = []
        # 本夜女巫是否已用解药(用了解药就不能再用毒药：一晚一瓶)
        self.witch_healed_tonight = False
        self._build()

    # ---- 构造阶段序列 ----
    def _build(self):
        s = self.state
        stages = self.stages

        # 混血儿：仅第一夜最先醒来，选择一名玩家作为榜样
        if s.day == 1 and s.players_with_role(HALFBLOOD):
            stages.append(self._handoff(HALFBLOOD, "混血儿"))
            stages.append({
                "type": "select", "role": HALFBLOOD,
                "title": "混血儿请选择一名玩家作为你的榜样",
                "hint": "你的胜负与榜样所在阵营一致，但你不会知道TA的身份。",
                "key": "halfblood",
                "skip_label": None,
            })

        # 守卫：板子有守卫就每晚叫醒；守卫已出局时仍走完整操作流程，
        # 但操作不生效（避免其他人从流程推断谁已出局）。
        if s.players_with_role(GUARD):
            stages.append(self._handoff(GUARD, "守卫"))
            stages.append({
                "type": "select", "role": GUARD,
                "title": "守卫请选择今晚要守护的人",
                "hint": "不能连续两晚守护同一个人，也可以选择空守。",
                "key": "guard",
                "skip_label": "空守(不守护任何人)",
                "active": bool(s.alive_role(GUARD)),
            })

        # 狼人
        if s.alive_role(WEREWOLF):
            wolf_names = "、".join(p.name for p in s.alive_role(WEREWOLF))
            stages.append(self._handoff(
                WEREWOLF, "狼人",
                extra="今晚在场狼人：%s" % wolf_names))
            stages.append({
                "type": "select", "role": WEREWOLF,
                "title": "狼人请选择今晚要击杀的目标",
                "hint": "可以选择击杀狼队友(自刀)，也可以选择空刀。",
                "key": "wolf",
                "skip_label": "空刀(今晚不杀人)",
            })

        # 女巫：板子有女巫则每晚都叫醒，走完解药/毒药全部操作流程。
        # 女巫已出局或药已用完时仍然操作，但一切选择不生效
        # （避免其他人从是否叫醒推断女巫死活 / 药品情况）。
        # 注意：解药阶段里的「今晚被刀者」要等到狼人行动后才确定，
        # 因此不在构建时缓存，由 UI 渲染该阶段时从实时状态读取。
        witch = s.witch()
        if witch:
            stages.append(self._handoff(WITCH, "女巫"))
            stages.append({"type": "witch_heal", "role": WITCH,
                           "active": s.heal_available()})
            # 8 人以下板子本来就没有毒药，不出现该环节
            if s.poison_enabled:
                stages.append({
                    "type": "select", "role": WITCH,
                    "title": "女巫请选择毒药目标",
                    "hint": "解药与毒药同一个晚上只能用其中一瓶，也可以选择不使用。",
                    "key": "poison",
                    "skip_label": "不使用毒药",
                    "active": s.poison_available(),
                })

        # 预言家：板子有预言家就每晚叫醒；已出局时仍走查验流程(不生效)，
        # 查验结果照常展示给已出局者(不影响局面)。
        if s.players_with_role(SEER):
            stages.append(self._handoff(SEER, "预言家"))
            stages.append({
                "type": "select", "role": SEER,
                "title": "预言家请选择今晚要查验的人",
                "hint": "",
                "key": "seer",
                "skip_label": None,
                "active": bool(s.alive_role(SEER)),
            })
            stages.append({"type": "seer_result", "target": None,
                           "is_wolf": False})

        # 猎人：板子有猎人则每晚都叫醒，无论死活与是否已结算。
        # 已结算(开过枪/放弃)的猎人走个过场即可，避免其他人从流程推断其死活。
        if s.players_with_role(HUNTER):
            stages.append(self._handoff(HUNTER, "猎人"))
            stages.append({"type": "hunter_ask"})

        stages.append({"type": "end"})

    def _handoff(self, role, role_cn, extra=""):
        return {"type": "handoff", "role": role, "role_cn": role_cn,
                "extra": extra}

    def witch_heal_info(self):
        """渲染解药阶段时读取的实时信息。

        返回 (target_seat|None, can_heal, reason)。
        规则：解药只能让被刀者免死；非首夜女巫不能自救。
        """
        s = self.state
        target = s.night.wolf_target
        witch = s.witch()
        if target is None:
            return None, True, ""          # 今晚空刀，无需解救
        if target == witch.seat and s.day > 1:
            return target, False, "非首夜女巫不能自救"
        return target, True, ""

    # ---- 驱动 ----
    def current(self):
        return self.stages[self.cursor]

    def has_next(self):
        return self.cursor < len(self.stages) - 1

    def _stage_skipped(self, st):
        """本夜已用解药后，毒药环节直接跳过(一晚只能用一瓶药)。"""
        return (st.get("type") == "select"
                and st.get("key") == "poison"
                and self.witch_healed_tonight)

    def next_stage(self):
        while self.has_next():
            self.cursor += 1
            if not self._stage_skipped(self.current()):
                break
        return self.current()

    def can_guard(self, seat):
        """守卫规则：不能连续两晚守同一人。"""
        return seat != self.state.last_guard_target

    def alive_choices(self):
        """选择目标时的候选(仅存活玩家)。"""
        return list(self.state.alive_players())

    def commit(self, stage, value):
        """提交一个选择类阶段的结果。value 为座位号或 None。"""
        s = self.state
        kind = stage["type"]
        active = stage.get("active", True)
        if not active:
            # 已出局角色 / 已用完的药：操作仅走流程，不写入任何局面状态。
            # 例外：预言家即便已出局，仍把(只读的)查验结果填进结果页。
            if (kind == "select" and stage.get("key") == "seer"
                    and value is not None):
                tgt = s.player(value)
                for st in self.stages:
                    if st["type"] == "seer_result":
                        st["target"] = value
                        st["is_wolf"] = tgt.is_wolf
                        break
            return
        if kind == "select":
            key = stage["key"]
            if key == "guard":
                s.night.guard_target = value
                if value is not None:
                    s.log.append("第%d夜 守卫守护了 %s"
                                 % (s.day, s.player(value).name))
                else:
                    s.log.append("第%d夜 守卫空守" % s.day)
            elif key == "wolf":
                s.night.wolf_target = value
                if value is not None:
                    s.log.append("第%d夜 狼人袭击了 %s"
                                 % (s.day, s.player(value).name))
                else:
                    s.log.append("第%d夜 狼人空刀" % s.day)
            elif key == "poison":
                s.night.witch_poison_target = value
                if value is not None:
                    s.log.append("第%d夜 女巫毒杀了 %s"
                                 % (s.day, s.player(value).name))
                else:
                    s.log.append("第%d夜 女巫未使用毒药" % s.day)
            elif key == "seer":
                target = s.player(value)
                s.night.seer_target = value
                s.night.seer_is_wolf = target.is_wolf
                s.log.append("第%d夜 预言家查验 %s（%s）" % (
                    s.day, target.name, "狼人" if target.is_wolf else "好人"))
                # 把结果写进紧随其后的 seer_result 阶段
                for st in self.stages:
                    if st["type"] == "seer_result":
                        st["target"] = value
                        st["is_wolf"] = target.is_wolf
                        break
            elif key == "halfblood":
                # 榜样持久化到 state(夜晚记录每晚重置)，混血整局跟随
                s.halfblood_target = value
                s.night.halfblood_target = value
                s.log.append("第%d夜 混血儿选定 %s 为榜样"
                             % (s.day, s.player(value).name))
        elif kind == "witch_heal":
            s.night.witch_heal = bool(value)
            target = s.night.wolf_target
            if value:
                # 用了解药，本夜毒药环节自动跳过
                self.witch_healed_tonight = True
                if target is not None:
                    s.log.append("第%d夜 女巫用解药救了 %s"
                                 % (s.day, s.player(target).name))
            elif target is not None:
                s.log.append("第%d夜 女巫未对 %s 使用解药"
                             % (s.day, s.player(target).name))
        elif kind == "hunter_ask":
            if s.players_with_role(HUNTER):
                info = hunter_status(s)
                was_resolved = s.hunter_resolved
                if value is not None and info["can_shoot"]:
                    s.night.hunter_shoot_target = value
                    s.hunter_resolved = True
                elif (not info["alive"]) or info["dying_tonight"]:
                    # 已出局时放弃 / 被毒 / 今晚将死却放弃 -> 永久结算
                    if info["alive"] and info["dying_tonight"] \
                            and not was_resolved:
                        s.log.append("第%d夜 猎人放弃开枪" % s.day)
                    s.hunter_resolved = True
                # 存活且今晚安全时闭眼不算结算，之后每晚仍会询问


# ---------------------------------------------------------------- 夜晚结算
def hunter_status(state):
    """夜晚结算前推演猎人状态(不改动任何状态)，供 UI 展示与开枪判断。

    返回 dict 或 None(板子没有猎人)：
        alive          猎人当前是否存活
        dying_tonight  按未结算的刀/毒/守/救推演，今晚是否会出局
        cause          今晚死因('wolf'/'poison')；已出局时为历史死因
        can_shoot      枪是否可用(被毒永远不能开枪)
    """
    hs = state.players_with_role(HUNTER)
    if not hs:
        return None
    h = hs[0]
    if not h.alive:
        can = (h.death_cause in (CAUSE_WOLF, CAUSE_VOTE, CAUSE_SHOOT)
               and not state.hunter_resolved)
        return {"alive": False, "dying_tonight": False,
                "cause": h.death_cause, "can_shoot": can}
    n = state.night
    if n.witch_poison_target == h.seat:
        return {"alive": True, "dying_tonight": True,
                "cause": CAUSE_POISON, "can_shoot": False}
    if n.wolf_target == h.seat:
        guarded = (n.guard_target == h.seat)
        healed = n.witch_heal
        if not (guarded or healed) or (guarded and healed):
            # 无人保护 / 同守同救奶穿 -> 今晚死于刀
            return {"alive": True, "dying_tonight": True,
                    "cause": CAUSE_WOLF, "can_shoot": True}
    return {"alive": True, "dying_tonight": False, "cause": None,
            "can_shoot": True}


def resolve_night(state):
    """根据夜间行动计算死亡，更新玩家状态，返回 [(seat, cause)]。"""
    n = state.night
    deaths = {}  # seat -> cause(poison 优先级高，影响猎人能否开枪)

    wt = n.wolf_target
    if wt is not None:
        guarded = (n.guard_target == wt)
        healed = n.witch_heal
        if guarded and healed:
            # 同守同救：奶穿，依然死亡
            deaths[wt] = CAUSE_WOLF
        elif guarded or healed:
            pass  # 被守下或被救下
        else:
            deaths[wt] = CAUSE_WOLF

    pt = n.witch_poison_target
    if pt is not None:
        # 毒药无视守护；若刀、毒落在同一人头上，按毒死处理(不能开枪)
        deaths[pt] = CAUSE_POISON

    result = []
    for seat in sorted(deaths):
        p = state.player(seat)
        if p.alive:
            p.alive = False
            p.death_cause = deaths[seat]
            result.append((seat, deaths[seat]))

    # 猎人夜间开枪：猎人确实出局(死于本夜之刀 / 此前非毒出局)才生效
    if n.hunter_shoot_target is not None and state.players_with_role(HUNTER):
        h = state.players_with_role(HUNTER)[0]
        hunter_dies = (deaths.get(h.seat) == CAUSE_WOLF) or (
            not h.alive and h.death_cause != CAUSE_POISON)
        if hunter_dies:
            t = state.player(n.hunter_shoot_target)
            if t.alive and t.seat not in deaths:
                t.alive = False
                t.death_cause = CAUSE_SHOOT
                result.append((t.seat, CAUSE_SHOOT))
                state.log.append("第%d夜 猎人开枪带走了 %s"
                                 % (state.day, t.name))
            state.hunter_resolved = True

    state.last_night_deaths = result
    state.last_guard_target = n.guard_target
    if n.witch_heal:
        state.witch_heal_used = True
    if n.witch_poison_target is not None:
        state.witch_poison_used = True

    state.log.append("第%d夜死亡：%s" % (
        state.day,
        "、".join("%s(%s)" % (state.player(s).name, ROLE_NAME[state.player(s).role])
                  for s, _ in result) or "平安夜"))
    return result


def death_announcement_text(state):
    """天亮死亡播报文案(供系统 TTS 朗读)：昨夜 X号 昵称 死因。"""
    deaths = state.last_night_deaths
    if not deaths:
        return "昨夜是平安夜，没有人死亡。"

    tts_cause = {
        CAUSE_WOLF: "遭到狼人强奸",
        CAUSE_POISON: "遭到女巫毒杀",
        CAUSE_SHOOT: "被猎人射杀",
        CAUSE_MANUAL: "遭到系统踢出",
        CAUSE_VOTE: "被投票出局",
    }

    def part(seat, cause):
        p = state.player(seat)
        name = (p.name or "").strip()
        # 默认昵称本身就是「X号」，避免读成「3号 3号」
        who = name if name in ("%d号" % seat, "%d号位" % seat) \
            else "%d号 %s" % (seat, name)
        return who + tts_cause.get(cause, "被淘汰")

    return "昨夜%s。" % "、".join(
        part(seat, cause) for seat, cause in deaths)


def hunter_can_shoot(state, seat):
    """猎人死于刀/投/被带走/手动出局可开枪，被毒不能开枪。"""
    p = state.player(seat)
    return p.role == HUNTER and p.death_cause in (CAUSE_WOLF, CAUSE_VOTE, CAUSE_SHOOT, CAUSE_MANUAL)


def shoot(state, seat):
    """猎人发动技能带走一名存活玩家。"""
    p = state.player(seat)
    if p.alive:
        p.alive = False
        p.death_cause = CAUSE_SHOOT
        state.log.append("第%d天 猎人开枪带走了 %s" % (state.day, p.name))
        return True
    return False


def exile(state, seat):
    """白天投票出局，seat 为 None 表示平票无人出局。"""
    if seat is None:
        state.log.append("第%d天白天：平票，无人出局" % state.day)
        return
    p = state.player(seat)
    if p.alive:
        p.alive = False
        p.death_cause = CAUSE_VOTE
        state.log.append("第%d天白天：%s 被投票出局" % (state.day, p.name))


def manual_exile(state, seat):
    """白天手动出局（主持人/普通模式均可用），并记录到对局日志。"""
    p = state.player(seat)
    if p.alive:
        p.alive = False
        p.death_cause = CAUSE_MANUAL
        state.log.append("第%d天白天：%s 被手动出局" % (state.day, p.name))


def advance_to_next_night(state):
    state.day += 1
    start_night(state)


# ---------------------------------------------------------------- 胜负判定
def check_winner(state):
    """胜负判定，支持两种规则(state.win_rule)：

    'bian' 屠边(默认)：狼人全灭 -> 好人胜；
        开局存在神职且已全灭 -> 狼人胜；
        开局存在村民且已全灭 -> 狼人胜。
    'cheng' 屠城：狼人全灭 -> 好人胜；所有好人(神+民)全灭 -> 狼人才胜。
    """
    wolves = state.alive_role(WEREWOLF)
    goods = [p for p in state.alive_players() if not p.is_wolf]
    if not wolves:
        state.winner = "good"
        return state.winner
    if getattr(state, "win_rule", "bian") == "cheng":
        if not goods:
            state.winner = "wolf"
    else:
        gods = [p for p in goods if p.is_god]
        # 混血儿在屠边局中占民坑
        villagers = [p for p in goods if p.role in VILLAGER_ROLES]
        if state.init_gods > 0 and not gods:
            state.winner = "wolf"
        elif state.init_villagers > 0 and not villagers:
            state.winner = "wolf"
    return state.winner


# ---------------------------------------------------------------- 存档/恢复
# 对局中途退出后恢复：GameState / NightAction / NightFlow 都是普通对象，
# 直接 pickle 为 base64 字符串，方便写入文件或 localStorage。
def snapshot_state(state):
    """把当前对局(含夜晚流程进度、对局日志)序列化为 ASCII 字符串。"""
    return base64.b64encode(pickle.dumps(state)).decode("ascii")


def restore_state(token):
    """snapshot_state 的逆操作，返回 GameState。"""
    return pickle.loads(base64.b64decode(token.encode("ascii")))


def snapshot_game(state, flow=None):
    """连夜晚流程进度(NightFlow.cursor 等)一起快照，供中途退出后原样恢复。"""
    return base64.b64encode(
        pickle.dumps({"state": state, "flow": flow})).decode("ascii")


def restore_game(token):
    """snapshot_game 的逆操作，返回 (state, flow)，flow 可能为 None。"""
    data = pickle.loads(base64.b64decode(token.encode("ascii")))
    return data["state"], data["flow"]


def game_summary(state):
    """对局摘要(JSON 安全的纯 dict/list)，用于历史对局列表。"""
    return {
        "day": state.day,
        "win_rule": state.win_rule,
        "winner": state.winner,
        "total": len(state.players),
        "board": board_summary([p.role for p in state.players]),
        "players": [
            {"seat": p.seat, "name": p.name, "role": p.role,
             "alive": p.alive, "death_cause": p.death_cause}
            for p in state.players
        ],
        "log": list(state.log),
    }


def halfblood_result(state):
    """终局时混血儿的胜负归属。

    返回 None(无混血/未选榜样)，否则返回 dict：
        seat / name     混血儿
        model_seat/name 榜样
        model_wolf      榜样是否狼人阵营
        won             混血儿是否与胜方同阵营
    """
    hb = state.halfblood()
    if hb is None or state.halfblood_target is None:
        return None
    model = state.player(state.halfblood_target)
    model_wolf = model.is_wolf
    won = (state.winner == "wolf") if model_wolf else (state.winner == "good")
    return {
        "seat": hb.seat, "name": hb.name,
        "model_seat": model.seat, "model_name": model.name,
        "model_wolf": model_wolf, "won": won,
    }
