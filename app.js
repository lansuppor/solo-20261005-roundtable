import fs from 'node:fs';
import path from 'node:path';

const NAME = 'roundtable';

// 固定规则，不使用随机数。
const PLAYER_MAX_HP = 10;
const PLAYER_ATTACK = 4;
const ENEMY_MAX_HP = 12;
const ENEMY_ATTACK = 3;
const POTION_HEAL = 6;
const START_POTIONS = 1;
const DEFENDED_DAMAGE = 1;
const SAVE_VERSION = 1;

const ACTIONS = new Map([
  ['attack', 'attack'], ['a', 'attack'], ['攻击', 'attack'],
  ['defend', 'defend'], ['d', 'defend'], ['防御', 'defend'],
  ['potion', 'potion'], ['p', 'potion'], ['喝药', 'potion'],
]);

const HELP = `${NAME}

用法:
  node app.js                              显示本帮助
  node app.js --help | -h                  显示本帮助
  node app.js new <存档路径> <角色名>       新建遭遇（存档已存在则报错，不覆盖）
  node app.js status <存档路径>            查看当前状态
  node app.js act <存档路径> <行动>        提交行动：attack | defend | potion
  node app.js log <存档路径>               按回合查看行动记录

规则: 角色生命 10、攻击 4、治疗药 1 瓶（恢复 6）；敌人生命 12、攻击 3。
防御使本回合敌方伤害降为 1。每个有效行动构成一个完整回合。`;

class GameError extends Error {} // 业务/运行错误，退出码 1
class UsageError extends Error {} // 参数错误，退出码 2

function fail(message) {
  throw new GameError(message);
}

function failUsage(message) {
  throw new UsageError(message);
}

// ---------- 存档读写 ----------

function initialState(name) {
  return {
    version: SAVE_VERSION,
    name,
    player: { hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, attack: PLAYER_ATTACK, potions: START_POTIONS },
    enemy: { hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP, attack: ENEMY_ATTACK },
    turn: 1,
    status: 'ongoing', // ongoing | victory | defeat
    endTurn: null,
    log: [],
  };
}

// 将数据原子写入已有存档：临时文件 + fsync + rename。
// 任何一步失败都不会改动既有存档字节，也不留临时文件。
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    fail(`保存失败：${err.message}（既有存档未改动）`);
  }
}

// 新建存档：先完整写好临时文件，再用硬链接原子落位。
// 目标已存在时 link 失败，绝不覆盖；失败时清理临时文件，不留下可误认的存档。
function createSave(file, data) {
  if (fs.existsSync(file)) {
    fail(`存档已存在：${file}（新建不会覆盖已有存档）`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tmp, file);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 忽略 */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    if (err && err.code === 'EEXIST') {
      fail(`存档已存在：${file}（新建不会覆盖已有存档）`);
    }
    fail(`新建存档失败：${err.message}`);
  }
  try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
}

function loadSave(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      fail(`存档不存在：${file}（请先用 new 命令新建）`);
    }
    fail(`读取存档失败：${err.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    fail(`存档内容损坏（不是有效 JSON）：${file}，已拒绝继续，存档未被改动`);
  }
  const problem = validateState(state);
  if (problem) {
    fail(`存档校验失败：${problem}，已拒绝继续，存档未被改动`);
  }
  return state;
}

// ---------- 校验（含确定性重放，保证状态与记录一致） ----------

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// 按固定规则重放记录，返回终态；任何一步不一致返回 null。
function replay(log) {
  let php = PLAYER_MAX_HP;
  let ehp = ENEMY_MAX_HP;
  let potions = START_POTIONS;
  for (let i = 0; i < log.length; i += 1) {
    const e = log[i];
    if (!e || typeof e !== 'object') return null;
    if (e.turn !== i + 1) return null;
    let playerDamage = 0;
    let healed = 0;
    let enemyDamage = 0;
    if (e.action === 'attack') {
      playerDamage = Math.min(PLAYER_ATTACK, ehp);
      ehp -= playerDamage;
    } else if (e.action === 'potion') {
      if (potions <= 0 || php >= PLAYER_MAX_HP) return null;
      potions -= 1;
      healed = Math.min(POTION_HEAL, PLAYER_MAX_HP - php);
      php += healed;
    } else if (e.action !== 'defend') {
      return null;
    }
    let outcome = null;
    if (ehp === 0) {
      outcome = 'victory';
    } else {
      enemyDamage = Math.min(e.action === 'defend' ? DEFENDED_DAMAGE : ENEMY_ATTACK, php);
      php -= enemyDamage;
      if (php === 0) outcome = 'defeat';
    }
    if (e.playerDamage !== playerDamage || e.healed !== healed ||
        e.enemyDamage !== enemyDamage || e.playerHp !== php ||
        e.enemyHp !== ehp || e.outcome !== outcome) {
      return null;
    }
    if (outcome !== null && i !== log.length - 1) return null;
  }
  return { php, ehp, potions };
}

function validateState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return '存档结构不是对象';
  if (s.version !== SAVE_VERSION) return '存档版本不受支持';
  if (typeof s.name !== 'string' || s.name.trim() === '') return '角色名为空';
  const { player, enemy } = s;
  if (!player || typeof player !== 'object' || !enemy || typeof enemy !== 'object') {
    return '缺少玩家或敌人数据';
  }
  if (player.maxHp !== PLAYER_MAX_HP || player.attack !== PLAYER_ATTACK ||
      enemy.maxHp !== ENEMY_MAX_HP || enemy.attack !== ENEMY_ATTACK) {
    return '固定规则数值被篡改';
  }
  if (!isInt(player.hp, 0, PLAYER_MAX_HP)) return '玩家生命越界';
  if (!isInt(enemy.hp, 0, ENEMY_MAX_HP)) return '敌人生命越界';
  if (!isInt(player.potions, 0, Number.MAX_SAFE_INTEGER)) return '药瓶数量越界';
  if (!isInt(s.turn, 1, Number.MAX_SAFE_INTEGER)) return '回合数越界';
  if (!['ongoing', 'victory', 'defeat'].includes(s.status)) return '结局状态非法';
  if (!Array.isArray(s.log)) return '行动记录缺失';
  const end = replay(s.log);
  if (!end) return '行动记录与规则矛盾';
  if (end.php !== player.hp || end.ehp !== enemy.hp || end.potions !== player.potions) {
    return '状态与行动记录不一致';
  }
  if (s.status === 'ongoing') {
    if (s.endTurn !== null) return '进行中的存档带有结束回合号';
    if (s.turn !== s.log.length + 1) return '回合数与行动记录不连续';
    if (player.hp === 0 || enemy.hp === 0) return '结局与生命矛盾';
  } else {
    if (s.log.length === 0 || s.endTurn !== s.log.length) return '结束回合号与记录矛盾';
    if (s.turn !== s.log.length + 1) return '回合数与行动记录不连续';
    if (s.status === 'victory' && !(enemy.hp === 0 && player.hp > 0)) return '结局与生命矛盾';
    if (s.status === 'defeat' && !(player.hp === 0 && enemy.hp > 0)) return '结局与生命矛盾';
  }
  return null;
}

// ---------- 回合结算 ----------

function applyAction(state, action) {
  const entry = {
    turn: state.turn,
    action,
    playerDamage: 0,
    healed: 0,
    enemyDamage: 0,
    playerHp: state.player.hp,
    enemyHp: state.enemy.hp,
    outcome: null,
  };
  if (action === 'attack') {
    entry.playerDamage = Math.min(state.player.attack, state.enemy.hp);
    state.enemy.hp -= entry.playerDamage;
  } else if (action === 'potion') {
    if (state.player.potions <= 0) fail('没有治疗药了，喝药被拒绝（本回合未发生）');
    if (state.player.hp >= state.player.maxHp) fail('生命已满，喝药被拒绝（本回合未发生）');
    state.player.potions -= 1;
    entry.healed = Math.min(POTION_HEAL, state.player.maxHp - state.player.hp);
    state.player.hp += entry.healed;
  }
  if (state.enemy.hp === 0) {
    state.status = 'victory';
    state.endTurn = state.turn;
    entry.outcome = 'victory';
  } else {
    entry.enemyDamage = Math.min(action === 'defend' ? DEFENDED_DAMAGE : state.enemy.attack, state.player.hp);
    state.player.hp -= entry.enemyDamage;
    if (state.player.hp === 0) {
      state.status = 'defeat';
      state.endTurn = state.turn;
      entry.outcome = 'defeat';
    }
  }
  entry.playerHp = state.player.hp;
  entry.enemyHp = state.enemy.hp;
  state.log.push(entry);
  state.turn += 1;
  return entry;
}

// ---------- 展示 ----------

function statusText(s) {
  const lines = [
    `角色「${s.name}」  生命 ${s.player.hp}/${s.player.maxHp}  治疗药 ${s.player.potions} 瓶`,
    `敌人            生命 ${s.enemy.hp}/${s.enemy.maxHp}`,
  ];
  if (s.status === 'ongoing') {
    lines.push(`第 ${s.turn} 回合，战斗进行中`);
  } else {
    lines.push(s.status === 'victory'
      ? `战斗已结束：第 ${s.endTurn} 回合胜利`
      : `战斗已结束：第 ${s.endTurn} 回合战败`);
  }
  return lines.join('\n');
}

const ACTION_LABEL = { attack: '攻击', defend: '防御', potion: '喝药' };

function entryText(e) {
  let playerPart;
  if (e.action === 'attack') playerPart = `攻击，造成 ${e.playerDamage} 点伤害`;
  else if (e.action === 'potion') playerPart = `喝药，恢复 ${e.healed} 点生命`;
  else playerPart = '防御';
  const enemyPart = e.outcome === 'victory'
    ? '敌人倒下，无法反击'
    : `敌人反击，造成 ${e.enemyDamage} 点伤害`;
  const tail = e.outcome === 'victory' ? '——胜利'
    : e.outcome === 'defeat' ? '——战败' : '';
  return `第 ${e.turn} 回合：${playerPart}；${enemyPart}。` +
    `结算后 角色 ${e.playerHp} 生命 / 敌人 ${e.enemyHp} 生命${tail}`;
}

// ---------- 命令 ----------

function cmdNew(args) {
  const [file, ...nameParts] = args;
  const name = nameParts.join(' ').trim();
  if (!file || name === '') failUsage('用法：node app.js new <存档路径> <角色名>（角色名不能为空）');
  const state = initialState(name);
  createSave(path.resolve(file), `${JSON.stringify(state, null, 2)}\n`);
  console.log(`已为「${name}」新建遭遇：${path.resolve(file)}`);
  console.log(statusText(state));
}

function cmdStatus(args) {
  const [file] = args;
  if (args.length !== 1) failUsage('用法：node app.js status <存档路径>');
  console.log(statusText(loadSave(path.resolve(file))));
}

function cmdLog(args) {
  const [file] = args;
  if (args.length !== 1) failUsage('用法：node app.js log <存档路径>');
  const state = loadSave(path.resolve(file));
  if (state.log.length === 0) {
    console.log('（尚无行动记录）');
    return;
  }
  console.log(state.log.map(entryText).join('\n'));
}

function cmdAct(args) {
  const [file, rawAction] = args;
  if (args.length !== 2) failUsage('用法：node app.js act <存档路径> <attack|defend|potion>');
  const action = ACTIONS.get(rawAction);
  if (!action) failUsage(`未知行动：${rawAction}（可选 attack | defend | potion）`);
  const resolved = path.resolve(file);
  const state = loadSave(resolved);
  if (state.status !== 'ongoing') {
    fail(`战斗已于第 ${state.endTurn} 回合结束（${state.status === 'victory' ? '胜利' : '战败'}），不能再行动；可查看状态或记录`);
  }
  const entry = applyAction(state, action); // 无效行动在此抛错，不写盘
  writeAtomic(resolved, `${JSON.stringify(state, null, 2)}\n`);
  console.log(entryText(entry));
  console.log(statusText(state));
}

const COMMANDS = { new: cmdNew, status: cmdStatus, act: cmdAct, log: cmdLog };

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(HELP);
    return;
  }
  const command = COMMANDS[args[0]];
  if (!command) {
    console.error(`${NAME}: unknown arguments; use --help`);
    process.exitCode = 2;
    return;
  }
  try {
    command(args.slice(1));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${NAME}: ${err.message}`);
      process.exitCode = 2;
    } else if (err instanceof GameError) {
      console.error(`${NAME}: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();
