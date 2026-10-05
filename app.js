import { open, link, rename, unlink, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const APP = 'roundtable';

const PLAYER_MAX_HP = 10;
const PLAYER_ATK = 4;
const ENEMY_MAX_HP = 12;
const ENEMY_ATK = 3;
const POTION_HEAL = 6;
const DEFEND_DAMAGE = 1;
const VERSION = 1;

const ACTIONS = new Map([
  ['attack', 'attack'],
  ['攻击', 'attack'],
  ['defend', 'defend'],
  ['防御', 'defend'],
  ['potion', 'potion'],
  ['drink', 'potion'],
  ['喝药', 'potion'],
]);

class UsageError extends Error {}
class DomainError extends Error {}
class SaveExistsError extends Error {}

const HELP = `${APP}

回合制单场遭遇命令行游戏。规则固定、无随机数；每个存档互相独立，
所有进度保存在指定的本地 JSON 文件中，关闭进程后可继续。

用法：
  node app.js [--help|-h]
      显示本帮助。

  node app.js new <存档路径> --name <角色名>
      新建一场遭遇。角色生命 10/10、攻击 4、持有 1 瓶治疗药；
      敌人生命 12/12、攻击 3；从第 1 回合开始。
      已有存档不会被覆盖；非空角色名。

  node app.js status <存档路径>
      查看当前状态（不改动存档）。

  node app.js log <存档路径>
      按回合顺序查看行动记录（不改动存档）。

  node app.js act <存档路径> <attack|defend|potion>
      提交本回合行动（attack 攻击 / defend 防御 / potion 喝药）。
      行动与敌方反击在同一个回合内整体结算并原子落盘。

规则：
  attack  扣除敌人 4 点生命（不低于 0），敌人死亡立即胜利且不反击。
  defend  本回合受到的敌方伤害降为 1，不叠加，不消耗物品。
  potion  消耗 1 瓶药，恢复 6 点生命（不超过上限）；
          生命已满或无药时拒绝，不推进回合。
  敌人在玩家行动后仍存活则反击（防御时造成 1 点，否则 3 点）；
  角色生命降为 0 立即失败。无效行动与终局后的行动不会被记录。

退出码：0 成功；1 运行或存档错误；2 参数错误。
`;

function isInt(v, min = -Infinity, max = Infinity) {
  return Number.isInteger(v) && v >= min && v <= max;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertStateShape(s) {
  const fail = (m) => { throw new DomainError(m); };
  if (!isPlainObject(s)) fail('存档不是有效对象');
  if (s.version !== VERSION) fail(`不支持的存档版本：${JSON.stringify(s.version)}`);

  const p = s.player;
  const e = s.enemy;
  if (!isPlainObject(p) || !isPlainObject(e)) fail('角色或敌人数据缺失');
  if (typeof p.name !== 'string' || p.name.trim().length === 0) fail('角色名无效');
  if (!isInt(p.hp, 0, PLAYER_MAX_HP)) fail('角色生命越界');
  if (p.maxHp !== PLAYER_MAX_HP) fail('角色生命上限异常');
  if (p.atk !== PLAYER_ATK) fail('角色攻击力异常');
  if (!isInt(p.potions, 0, 1)) fail('治疗药数量越界');
  if (!isInt(e.hp, 0, ENEMY_MAX_HP)) fail('敌人生命越界');
  if (e.maxHp !== ENEMY_MAX_HP) fail('敌人生命上限异常');
  if (e.atk !== ENEMY_ATK) fail('敌人攻击力异常');
  if (!isInt(s.turn, 1)) fail('回合数异常');
  if (!['ongoing', 'won', 'lost'].includes(s.status)) fail('结局状态异常');
  if (!Array.isArray(s.log)) fail('行动记录缺失');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    const va = a[k];
    const vb = b[k];
    if (Array.isArray(va) || Array.isArray(vb)) {
      if (!Array.isArray(va) || !Array.isArray(vb) || va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i++) if (!deepEqual(va[i], vb[i])) return false;
    } else if (isPlainObject(va) || isPlainObject(vb)) {
      if (!deepEqual(va, vb)) return false;
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}

// 纯函数：按固定规则结算一个回合。供实际行动与读档重放共用。
function resolveTurn(action, pHp, eHp, potions) {
  const player = { action };
  if (action === 'attack') {
    const damage = Math.min(PLAYER_ATK, eHp);
    eHp -= damage;
    player.damage = damage;
  } else if (action === 'potion') {
    const healed = Math.min(POTION_HEAL, PLAYER_MAX_HP - pHp);
    pHp += healed;
    potions -= 1;
    player.healed = healed;
  }

  let enemy = null;
  let status = 'ongoing';
  if (eHp === 0) {
    status = 'won';
  } else {
    const raw = action === 'defend' ? DEFEND_DAMAGE : ENEMY_ATK;
    const damage = Math.min(raw, pHp);
    pHp -= damage;
    enemy = { action: 'attack', damage };
    if (pHp === 0) status = 'lost';
  }

  return {
    pHp,
    eHp,
    potions,
    status,
    entry: { turn: 0, player, enemy, playerHp: pHp, enemyHp: eHp, potions },
  };
}

// 严格校验：结构/数值检查 + 从第 1 回起重放日志，重放结果必须与存档完全一致。
function validateState(s) {
  assertStateShape(s);

  let pHp = PLAYER_MAX_HP;
  let eHp = ENEMY_MAX_HP;
  let potions = 1;
  let status = 'ongoing';
  const rebuiltLog = [];

  s.log.forEach((entry, i) => {
    if (!isPlainObject(entry)) throw new DomainError('行动记录项无效');
    if (entry.turn !== i + 1) throw new DomainError('行动记录回合不连续');
    const action = entry.player && entry.player.action;
    if (!['attack', 'defend', 'potion'].includes(action)) {
      throw new DomainError('行动记录包含未知行动');
    }
    if (action === 'potion' && potions === 0) throw new DomainError('记录与药水量矛盾');
    if (action === 'potion' && pHp === PLAYER_MAX_HP) {
      throw new DomainError('记录了满生命时喝药');
    }
    const r = resolveTurn(action, pHp, eHp, potions);
    r.entry.turn = i + 1;
    if (!deepEqual(entry, r.entry)) throw new DomainError('行动记录与规则结算不一致');
    rebuiltLog.push(r.entry);
    pHp = r.pHp;
    eHp = r.eHp;
    potions = r.potions;
    status = r.status;
    if (status !== 'ongoing' && i !== s.log.length - 1) {
      throw new DomainError('终局之后仍存在行动记录');
    }
  });

  const canonical = {
    version: VERSION,
    player: {
      name: s.player.name,
      hp: pHp,
      maxHp: PLAYER_MAX_HP,
      atk: PLAYER_ATK,
      potions,
    },
    enemy: { hp: eHp, maxHp: ENEMY_MAX_HP, atk: ENEMY_ATK },
    turn: status === 'ongoing' ? rebuiltLog.length + 1 : rebuiltLog.length,
    status,
    log: rebuiltLog,
  };
  if (!deepEqual(s, canonical)) throw new DomainError('状态与行动记录不一致');
}

async function fsyncFile(path) {
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function fsyncDirOf(path) {
  const dir = dirname(path) || '.';
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function tmpName(path) {
  return `${path}.tmp.${process.pid}.${randomUUID()}`;
}

// 先把完整内容写入同目录临时文件并 fsync，再原子改名；失败时目标文件保持原样。
async function atomicReplace(path, data) {
  const tmp = tmpName(path);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await fsyncDirOf(path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// 原子新建：link 在目标已存在时返回 EEXIST，保证绝不覆盖既有存档。
async function atomicCreate(path, data) {
  const tmp = tmpName(path);
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, path);
    } catch (err) {
      if (err.code === 'EEXIST') throw new SaveExistsError(path);
      throw err;
    }
    await fsyncDirOf(path);
    await unlink(tmp).catch(() => {});
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function loadState(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new DomainError(`存档不存在：${path}（请先用 new 新建）`);
    }
    throw new DomainError(`读取存档失败：${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError(`存档已损坏：不是有效的 JSON（${path}）`);
  }
  try {
    validateState(parsed);
  } catch (err) {
    throw new DomainError(`存档已损坏、数值越界或自相矛盾，拒绝继续：${err.message}`);
  }
  return parsed;
}

function initialState(name) {
  return {
    version: VERSION,
    player: {
      name,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      atk: PLAYER_ATK,
      potions: 1,
    },
    enemy: { hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP, atk: ENEMY_ATK },
    turn: 1,
    status: 'ongoing',
    log: [],
  };
}

function statusLabel(status) {
  if (status === 'won') return '胜利';
  if (status === 'lost') return '失败';
  return '进行中';
}

function renderStatus(s) {
  const p = s.player;
  const e = s.enemy;
  const lines = [
    `角色 ${p.name}  生命 ${p.hp}/${p.maxHp}  攻击 ${p.atk}  治疗药 ${p.potions}`,
    `敌人      生命 ${e.hp}/${e.maxHp}  攻击 ${e.atk}`,
    `当前回合：${s.turn}`,
    `状态：${statusLabel(s.status)}` +
      (s.status === 'ongoing' ? '' : `（第 ${s.turn} 回合结束）`),
  ];
  return lines.join('\n');
}

function describePlayer(entry) {
  const { action, damage, healed } = entry.player;
  if (action === 'attack') return `攻击，造成 ${damage} 点伤害`;
  if (action === 'defend') return '防御，本回合敌方伤害降为 1';
  return `喝药，恢复 ${healed} 点生命`;
}

function renderEntry(entry) {
  const lines = [
    `第 ${entry.turn} 回合`,
    `  角色：${describePlayer(entry)}`,
    entry.enemy === null
      ? '  敌人：已被击败，未反击'
      : `  敌人：攻击，造成 ${entry.enemy.damage} 点伤害`,
    `  结算后：角色 ${entry.playerHp}/${PLAYER_MAX_HP}，` +
      `敌人 ${entry.enemyHp}/${ENEMY_MAX_HP}，治疗药 ${entry.potions}`,
  ];
  return lines.join('\n');
}

function renderLog(s) {
  if (s.log.length === 0) return '（尚无行动记录）';
  return s.log.map(renderEntry).join('\n');
}

function parseNameFlag(rest) {
  let path = null;
  let name = null;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--name') {
      const v = rest[++i];
      if (v === undefined) throw new UsageError('--name 需要一个角色名');
      name = v;
    } else if (tok.startsWith('--name=')) {
      name = tok.slice('--name='.length);
    } else if (!tok.startsWith('-') && path === null) {
      path = tok;
    } else {
      throw new UsageError(`无法识别的参数：${tok}`);
    }
  }
  if (path === null) throw new UsageError('缺少存档路径');
  if (name === null) throw new UsageError('缺少 --name <角色名>');
  name = name.trim();
  if (name.length === 0) throw new UsageError('角色名不能为空');
  return { path, name };
}

function expectPath(rest) {
  if (rest.length !== 1 || rest[0].startsWith('-')) {
    throw new UsageError('该命令需要恰好一个存档路径参数');
  }
  return rest[0];
}

async function cmdNew(rest) {
  const { path, name } = parseNameFlag(rest);
  const state = initialState(name);
  try {
    await atomicCreate(path, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    if (err instanceof SaveExistsError) {
      throw new DomainError(`存档已存在，拒绝覆盖：${path}`);
    }
    throw new DomainError(`新建存档失败：${err.message}（${err.code ?? '未知错误'}）`);
  }
  console.log(`已在第 1 回合创建遭遇（角色：${name}）`);
  console.log(`存档：${path}`);
  console.log(renderStatus(state));
}

async function cmdStatus(rest) {
  const path = expectPath(rest);
  const state = await loadState(path);
  console.log(renderStatus(state));
}

async function cmdLog(rest) {
  const path = expectPath(rest);
  const state = await loadState(path);
  console.log(renderLog(state));
}

async function cmdAct(rest) {
  if (rest.length !== 2) throw new UsageError('用法：act <存档路径> <attack|defend|potion>');
  const [path, actionToken] = rest;
  if (path.startsWith('-')) throw new UsageError('存档路径无效');
  const action = ACTIONS.get(actionToken);
  if (action === undefined) {
    throw new UsageError(`未知行动：${actionToken}（可选 attack、defend、potion）`);
  }

  const state = await loadState(path);
  if (state.status !== 'ongoing') {
    throw new DomainError(
      `遭遇已于第 ${state.turn} 回合${statusLabel(state.status)}，不能继续行动`,
    );
  }
  if (action === 'potion' && state.player.potions === 0) {
    throw new DomainError('没有治疗药，行动被拒绝（回合未推进）');
  }
  if (action === 'potion' && state.player.hp === PLAYER_MAX_HP) {
    throw new DomainError('生命已满，喝药被拒绝（回合未推进）');
  }

  const r = resolveTurn(action, state.player.hp, state.enemy.hp, state.player.potions);
  r.entry.turn = state.turn;
  state.player.hp = r.pHp;
  state.enemy.hp = r.eHp;
  state.player.potions = r.potions;
  state.status = r.status;
  state.log.push(r.entry);
  if (state.status === 'ongoing') state.turn += 1;

  try {
    await atomicReplace(path, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    throw new DomainError(
      `保存失败：${err.message}（${err.code ?? '未知错误'}）；存档保持行动前状态`,
    );
  }

  console.log(renderEntry(r.entry));
  if (state.status !== 'ongoing') {
    console.log(`结局：${statusLabel(state.status)}（第 ${state.turn} 回合）`);
  } else {
    console.log(`进入第 ${state.turn} 回合`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(HELP);
    return;
  }

  const [cmd, ...rest] = args;
  try {
    switch (cmd) {
      case 'new':
        await cmdNew(rest);
        break;
      case 'status':
        await cmdStatus(rest);
        break;
      case 'log':
        await cmdLog(rest);
        break;
      case 'act':
        await cmdAct(rest);
        break;
      default:
        throw new UsageError(`未知命令或参数：${cmd}（使用 --help 查看用法）`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${APP}: ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(`${APP}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

await main();
