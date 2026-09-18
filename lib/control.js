/**
 * Control-prompt classifier.
 *
 * Tags short user messages with intent categories: GO/APPROVE/CONTINUE/
 * STATUS/STEER/OPEN/PIVOT/INVOKE/TASK/GIT/REPORT/PASTE/MEMORY/REFERENCE/
 * POINTER, plus shape-based fallback (SHAPE_*).
 *
 * Empirically calibrated against 5968-exchange vault — 100% short-prompt
 * coverage, 50/50 split between explicit clusters and Zipf-tail shapes.
 *
 * Usage:
 *   import { classifyPrompt } from './lib/control.js';
 *   const kind = classifyPrompt(userMessage);  // returns 'GO' | 'APPROVE' | ... | null
 *
 * Returns null if message is too long to be a control prompt
 * (default threshold: > 8 words).
 */

import { withUnicodeBoundary } from './regex-utils.js';

const MAX_WORDS = 8;

/**
 * Rebuild a RegExp with Cyrillic-safe word boundaries.
 * Used to repair literal patterns that contain `\b`.
 */
function fix(re) {
  return new RegExp(withUnicodeBoundary(re.source), re.flags);
}
function fixAll(arr) {
  return arr.map(([cat, regs]) => [cat, regs.map(fix)]);
}

const CATEGORIES = fixAll([
  ['GO', [
    /^(?:go|погнали|поехали|давай(?:те)?|делаем|let'?s go|погнал[аи]|погнали(?:!)?)$/i,
    /^(?:1[\s,.\-/]?2[\s,.\-/]?3|раз[\s,.\-/]?два[\s,.\-/]?три)\b/i,
    /^(?:one[- ]?shot|oneshot|шот|одним выстрелом)\b/i,
    /^(?:do it|do that|жми|пуск|fire|action)\b/i,
    /^(?:next|дальше|next step|следующее)\.?\!?$/i,
  ]],
  ['APPROVE', [
    /^(?:ok|okay|okey|окей|ок|kk|k|sure|fine|good|nice|cool|круто|здорово|супер|отлично)[.!]?$/i,
    /^(?:yes|yep|yeah|ye|да|ага|угу|именно|точно|верно|правильно|right|exactly)[.!]?$/i,
    /^(?:agreed|согласен|согласна|согласны|согл)[.!]?$/i,
    /^(?:✓|✅|👍|👌|💯|\+1|\+\+\+?)$/,
  ]],
  ['CONTINUE', [
    /^(?:continue|cont|conitnue|conitinue|continu)[.?!]?$/i,
    /^(?:продолжай|продолжаем|продолжи|поехали дальше|дальше)[.,!?]?/i,
    /^(?:да,?\s*давай(?:те)?)[.!?]?$/i,
    /^(?:давай(?:те)?\s*[,.]?\s*(?:попробуем|полпробуем|пробуем|сделаем|сдлеаем|сделаим|делаем|добавим|идём|идем))[.!?]?/i,
    /^(?:да,?\s*делаем)[.!?]?$/i,
    /^(?:resume|возобнови|keep going)[.!?]?$/i,
  ]],
  ['STATUS', [
    /^(?:status|статус|стстус|стат)[.?!]?$/i,
    /^(?:как (?:прогресс|идёт|идет|там процес[сc]?|оно|дела|идут дела))[?.!]?$/i,
    /^(?:ну\s)?(?:что\sтам|что в итоге|что по)[?.!]?$/i,
    /^(?:проверь|проврь|посмотри|глянь|псмотри|чекни|check)[.?!]?$/i,
    /^(?:посмотри|глянь|псмотри)\s(?:прогресс|деплоймент|статус|новости)\b/i,
    /^(?:как идет|как идёт|как процесс|how'?s it going)[?.!]?$/i,
    /^(?:ну что[?.!]?|ну как[?.!]?)$/i,
  ]],
  ['STEER', [
    /^(?:no|nope|нет|не\sто|не\sтак|неа|неправильно|wrong)[.!?]?$/i,
    /^(?:stop|стоп|wait|стой|погоди|подожди|halt|останов(?:и|им|ить)|останавливай|гаси|откатывае?м)\b/i,
    /^(?:back|обратно|назад|undo|откати|rollback)[.!?]?/i,
    /^(?:not\s\w+|без\s\w+)[.!?]?$/i,
    /^(?:try again|снова|перезапусти|перезапускай|retry|еще раз|ещё раз|преезапусти|не отвечает)\b/i,
    /^не двигается\b|не работает\b/i,
  ]],
  ['OPEN', [
    /^(?:tell me more|расскажи (?:больше|подробнее)|подробнее|больше|expand|develop|раскрой)[.!?]?$/i,
    /^(?:interesting|интересно|любопытно|curious|hm+|хм+)[.!?]?$/i,
    /^(?:копни|dig in|investigate|исследуй|explore)[.!?]?$/i,
    /^\?+$/,
    /^(?:why|почему|зачем|how|как)\??$/i,
  ]],
  ['PIVOT', [
    /^(?:а\s(?:ещё|еще|вот|кстати))\b/i,
    /^(?:btw|кстати|теперь|now|и\sвот|так|итак)\b/i,
    /^(?:а\sможно|а\sесли|what if|что если)\b/i,
  ]],
  ['INVOKE', [
    /^#\s+[/\w]/,
    /^\/[a-z][\w\-:]*/i,
  ]],
  ['TASK', [
    /^(?:делай|сделай|fix|почини|добавь|исправь|смотри|пробуем|попробуем|обновляй|обнови|готовь|подготовь|забирай|запускай|пушни|пушай|реализуй|поправь|откати|план|пробуй)[.!?)]*$/i,
    /^(?:сделай|делай|пусти|запусти|собери|пересобери|build|deploy|run|start|обнови|обновляй|готовь|подготовь|забирай)\s+\S{3,}/i,
    /^(?:проверь|посмотри|глянь|чекни|check|првоерь|проврь|помотри)\s+\S{3,}/i,
    /^(?:исправь|fix|почини|поправь|tidy|refactor)\s+\S{3,}/i,
    /^(?:напиши|write|создай|create|add|добавь|сделаай|нужно)\s+\S{3,}/i,
    /^(?:давай\s+(?:остановим|установим|закинем|глянем|поддержим|план(?:ируем|им)|спросим))/i,
  ]],
  ['GIT', [
    /^(?:commit|commmit|коммит|кмт|c'mit)[.,!?]?$/i,
    /^(?:let'?s?\s+commit)[.,!?]?$/i,
    /^(?:push|пуш|p)[.,!?]?$/i,
    /^(?:release|релиз|tag)[.,!?]?$/i,
    /^(?:commit\s*[,;]\s*release|commit\s+&?\s*push|push\s*[,;]\s*release|коммить?\s+и\s+продолжай)\b/i,
    /^(?:ship|merge|deploy)[.,!?]?$/i,
  ]],
  ['REPORT', [
    /^(?:закрыл|закрыла|открыл|закомитил|запушил|задеплоил|пущнул|пушнул|запустил|остановил|перезапустил|залил|сохранил|обновил|перезашёл|перезашел|починил|поправил|написал|собрал)\b/i,
    /^(?:я\s+(?:закрыл|запушил|залил|обновил|починил|сделал|собрал))\b/i,
    /^(?:работает|работает!|всё работает|всё ок|всё гуд|fixed|done|готово|готов|сделано|sent|отправил|заработал[оа]?|есть\sречь)[.!]*$/i,
    /^(?:закрыто|открыто|отправлено|опубликовано|uploaded|деплоится|задеплоено)\b/i,
    /^(?:не работает|сломалось|упало|broke|broken|crashed)[.!]?$/i,
  ]],
  ['PASTE', [
    /^[\w./-]+:\s*\d/,
    /^(?:params|step|epoch|loss|acc|train|val|tokens?|size|bytes)[\s:_]\w*/i,
    /^root@[a-f0-9]+:/,
    /^[a-z]+(?:error|exception):\s/i,
    /^(?:uncaught|unhandled|fatal|warning|error)\s+[a-z]+(?:error|exception)/i,
    /^bash:\s+(?:syntax\s+error|command\s+not\s+found)/i,
    /^(?:cuda|gpu|nvidia)[\d.]+\-/i,
    /^nohup:\s/,
    /^code\s+size:\s+\d/i,
    /^[a-z_]+:[a-z_]+\s+\w+=\w/i,
    /^\[\d+:\d+(?::\d+)?\s*(?:am|pm)?\]/i,
    /^\[\w+\]\s+\w+/,
    /^\/\d+\s+(?:train_loss|val_loss|val_bpb|train_time)/i,
    /^remote:\s/i,
    /^\([\w\s,]+\)\s*\d+\/\d+/,
    /^(?:gptq|ttt_chunk|mixed_precision|varlen_training|p_backends|pre-quantization|serialized model)\b/i,
    /^(?:loning|cloning|counting|compressing|writing)\s+(?:into\s+)?['"]/i,
    /^\[\d+\]\s+\d+/,
    /^only\s+\d+\/\d+/i,
    /^[a-z_]+\.(?:weight|bias)\b/i,
    /^update\(/i,
  ]],
  ['MEMORY', [
    /^(?:давай\s+)?(?:вс[ом]м?ни[мь]?|всмони|вспмони)\b/i,
    /^(?:recall|remember|чем мы занимались|что мы делали|что было в (?:прошлой|пред\w+)\s+сесси)/i,
  ]],
  ['REFERENCE', [
    /https?:\/\/\S+/i,
    /^(?:see|смотри|глянь)\s+(?:this|это)?\s*https?:\/\//i,
  ]],
  ['POINTER', [
    /^(?:get|config|шум|setup|deploy|tests?|build|stat|logs?|status)[.!?]?$/i,
    /^(?:status|конфиг|настройки|логи|тест|тесты|сборка|деплой|шум|тишина)[.!?]?$/i,
    /^[a-zа-яё]{3,12}[.!?]?$/i,
  ]],
]);

const SHAPE_REFERENCE = /https?:\/\/|file:\/\/|w:[\\/]|c:[\\/]/i;
const SHAPE_PASTE = /^[a-z_][\w/.\-]*[:=]\s*\S|^\s*\(\d+\s*[/,]\s*\d+\)|^\s*[\[(]\d+[:.]?\d*[\])]|^\s*\d+%\s+|^\s*\d+\/\d+\s+|tok\/s|train_loss|val_loss|bpb|hessians/i;
const SHAPE_QUESTION = /\?/;
const SHAPE_REPORT_TENSE = /^(?:[А-Яа-я]+(?:ал|ил|ел|ыл|ёл|ала|ила|оло|ало|ило))\b/i;
const SHAPE_IMPERATIVE = /^(?:[А-Яа-яёЁ]+(?:ай|яй|и|ь|уй))\b/i;

function shapeClassify(s) {
  if (SHAPE_REFERENCE.test(s)) return 'SHAPE_REFERENCE';
  if (SHAPE_PASTE.test(s)) return 'SHAPE_PASTE';
  if (SHAPE_QUESTION.test(s)) return 'SHAPE_QUESTION';
  if (SHAPE_REPORT_TENSE.test(s)) return 'SHAPE_REPORT';
  if (SHAPE_IMPERATIVE.test(s)) return 'SHAPE_IMPERATIVE';
  return 'SHAPE_FRAGMENT';
}

/**
 * Classify a user prompt into a control category.
 * Returns null if message is too long to be a control prompt.
 *
 * @param {string} userMessage
 * @param {object} [opts]
 * @param {number} [opts.maxWords=8]
 * @returns {string|null}
 */
export function classifyPrompt(userMessage, opts = {}) {
  if (!userMessage || typeof userMessage !== 'string') return null;
  const head = userMessage.trim().split('\n', 1)[0]
    .replace(/^[>\-*\d.\s]+/, '').trim();
  if (!head) return null;
  const wordCount = head.split(/\s+/).length;
  if (wordCount > (opts.maxWords ?? MAX_WORDS)) return null;
  for (const [cat, regs] of CATEGORIES) {
    for (const r of regs) {
      if (r.test(head)) return cat;
    }
  }
  return shapeClassify(head);
}

const CONTROL_CATEGORIES = [
  ...CATEGORIES.map(([n]) => n),
  'SHAPE_REFERENCE', 'SHAPE_PASTE', 'SHAPE_QUESTION',
  'SHAPE_REPORT', 'SHAPE_IMPERATIVE', 'SHAPE_FRAGMENT',
];
