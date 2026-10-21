// The Alice skill: «Алиса, спроси у КАИ расписания, какие пары завтра».
// Yandex Dialogs posts each phrase here (routes/api.js → POST /api/alice) and
// speaks the text we answer. Only reads the public schedule — exactly what
// the student page shows (utils/dayResolve.js) plus экзамены/зачёты — and
// remembers the student's group in the skill's own storage: per Yandex
// account when the user is logged in (user_state_update), otherwise per
// device (application_state). Nothing is written to our database.

const clock = require('./utils/clock');
const { addDaysToIsoDate, formatLocalDate } = require('./utils/date');
const { resolveGroupLessons, sortByTime, weekdayOf } = require('./utils/dayResolve');
const { scheduleGroupId } = require('./utils/groupJoin');
const { selectAttestations } = require('./utils/attestations');

const MAX_TEXT = 1024;
const WEEKDAYS = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const WEEKDAY_WORDS = [
    [1, /понедельник/], [2, /вторник/], [3, /сред[ауы]/], [4, /четверг/],
    [5, /пятниц[ауы]/], [6, /суббот[ауы]/], [7, /воскресень[ея]/]
];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const KIND_WORDS = { exam: 'экзамен', credit: 'зачёт', consultation: 'консультация' };
const BUTTONS = ['Сегодня', 'Завтра', 'На неделе', 'Сменить группу'];

const normalize = (text) => String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();

function plural(count, one, few, many) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

const spokenTime = (time) => time.replace(/^0/, '');

function dayLabel(iso, today) {
    const [, month, day] = iso.split('-').map(Number);
    const date = `${day} ${MONTHS[month - 1]}`;
    const weekday = WEEKDAYS[weekdayOf(iso)];
    const relative = { [today]: 'Сегодня', [addDaysToIsoDate(today, 1)]: 'Завтра', [addDaysToIsoDate(today, 2)]: 'Послезавтра', [addDaysToIsoDate(today, -1)]: 'Вчера' }[iso];
    const inWeekday = `в ${weekday}`.replace('в вторник', 'во вторник');
    return relative ? `${relative}, ${inWeekday}, ${date}` : `${inWeekday[0].toUpperCase()}${inWeekday.slice(1)}, ${date}`;
}

/** Pairs, events and session records of a group on one date, in time order. */
function dayItems(db, groupId, iso) {
    const owner = scheduleGroupId(db, groupId);
    const { lessons } = resolveGroupLessons(db, owner, iso);
    const attestations = selectAttestations(db, 'a.group_id = ? AND a.date = ?', [owner, iso])
        .map((record) => ({ ...record, attestation: true }));
    return sortByTime([...lessons, ...attestations]);
}

function describeItem(item) {
    // «с/з» is how the sheets write the gym; spoken, it has to be a word.
    const room = !item.room ? ''
        : /^\s*(онлайн|online|дистанционно)\s*$/i.test(item.room) ? ', онлайн'
            : /^\s*с\/з\s*$/i.test(item.room) ? ', спортзал'
                : `, аудитория ${item.room}`;

    if (item.attestation) {
        return `${spokenTime(item.time_start)} — ${KIND_WORDS[item.kind] || 'экзамен'} по предмету ${item.subject}${room}`;
    }

    const type = item.kind === 'event' || !item.lesson_type ? '' : `, ${item.lesson_type.toLowerCase().replace('лаб', 'лабораторная')}`;
    return `${spokenTime(item.time_start)} — ${item.subject}${type}${room}`;
}

function describeDay(db, groupId, iso, today) {
    const items = dayItems(db, groupId, iso);
    const label = dayLabel(iso, today);

    if (items.length === 0) {
        return `${label}: пар нет.`;
    }

    const pairs = items.filter((item) => !item.attestation && item.kind !== 'event').length;
    // Only an event or an exam that day: «пар нет», then what there is.
    const head = pairs > 0 ? `${pairs} ${plural(pairs, 'пара', 'пары', 'пар')}` : 'пар нет';
    return `${label}, ${head}. ${items.map(describeItem).join('. ')}.`;
}

function describeWeek(db, groupId, mondayIso, today) {
    const parts = [];

    for (let offset = 0; offset < 7; offset += 1) {
        const iso = addDaysToIsoDate(mondayIso, offset);
        const items = dayItems(db, groupId, iso);
        if (items.length === 0) continue;
        const first = items[0];
        parts.push(`${WEEKDAYS[weekdayOf(iso)].replace(/у$/, 'а')} — ${items.length} ${plural(items.length, 'занятие', 'занятия', 'занятий')}, с ${spokenTime(first.time_start)}`);
    }

    const [, month, day] = mondayIso.split('-').map(Number);
    return parts.length === 0
        ? `На неделе с ${day} ${MONTHS[month - 1]} пар нет.`
        : `Неделя с ${day} ${MONTHS[month - 1]}: ${parts.join('; ')}. Спросите про конкретный день, чтобы услышать пары.`;
}

/** The date a phrase asks about, or null: Alice's own date entity first, then words. */
function requestedDate(request, text, today) {
    const entity = (request.nlu?.entities || []).find((item) => item.type === 'YANDEX.DATETIME')?.value;

    if (entity) {
        if (entity.day_is_relative && Number.isInteger(entity.day)) {
            return addDaysToIsoDate(today, entity.day);
        }

        if (Number.isInteger(entity.day) && Number.isInteger(entity.month)) {
            const year = Number.isInteger(entity.year) ? entity.year : Number(today.slice(0, 4));
            const iso = `${year}-${String(entity.month).padStart(2, '0')}-${String(entity.day).padStart(2, '0')}`;
            if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
        }
    }

    if (/послезавтра/.test(text)) return addDaysToIsoDate(today, 2);
    if (/завтра/.test(text)) return addDaysToIsoDate(today, 1);
    if (/вчера/.test(text)) return addDaysToIsoDate(today, -1);
    if (/сегодня/.test(text)) return today;

    for (const [weekday, pattern] of WEEKDAY_WORDS) {
        if (pattern.test(text)) {
            // The coming one: today if today is that day, else the next.
            return addDaysToIsoDate(today, (weekday - weekdayOf(today) + 7) % 7);
        }
    }

    return null;
}

function findGroupByNumber(db, text) {
    // Speech often comes back split: «двадцать три сто один» → «23 101».
    const match = text.replace(/(\d)\s+(?=\d)/g, '$1').match(/(?:^|\D)(\d{5})(?!\d)/);
    if (!match) return { asked: null, group: null };
    return { asked: match[1], group: db.prepare('SELECT id, name FROM groups_ WHERE name = ?').get(match[1]) || null };
}

function answer(text, { end = false, remember, forget = false, isLoggedIn } = {}) {
    const response = {
        version: '1.0',
        response: {
            text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
            end_session: end,
            ...(end ? {} : { buttons: BUTTONS.map((title) => ({ title, hide: true })) })
        }
    };

    if (remember) {
        response.application_state = { group_id: remember.id, group_name: remember.name };
        if (isLoggedIn) response.user_state_update = { group_id: remember.id, group_name: remember.name };
    } else if (forget) {
        response.application_state = {};
        if (isLoggedIn) response.user_state_update = { group_id: null, group_name: null };
    }

    return response;
}

const HELP = 'Я рассказываю расписание групп НЧФ КАИ. Скажите номер группы, например «двадцать три сто один» или «23101», — я его запомню. '
    + 'Потом спрашивайте: «какие пары завтра», «что в пятницу», «расписание на неделю». Сменить группу — «другая группа».';

function handleAlice(db, body, now = clock.now()) {
    const request = body?.request || {};
    const session = body?.session || {};
    const state = body?.state || {};
    const isLoggedIn = Boolean(session.user?.user_id);
    const raw = request.original_utterance || request.command || '';
    const text = normalize(request.command || raw);
    const today = formatLocalDate(now);

    if (normalize(raw) === 'ping') {
        return answer('pong', { isLoggedIn });
    }

    if (/^(хватит|стоп|выход|выйти|закончить|все спасибо|спасибо все)$/.test(text)) {
        return answer('Хорошо, до встречи! Хорошего дня.', { end: true, isLoggedIn });
    }

    if (/помощь|что ты умеешь|что умеешь|как пользоваться/.test(text)) {
        return answer(HELP, { isLoggedIn });
    }

    if (/(другая|сменить|смени|поменять|поменяй|забудь|забыть)\s+групп/.test(text)) {
        return answer('Хорошо. Назовите номер вашей группы, например 23101.', { forget: true, isLoggedIn });
    }

    // A group named in the phrase is remembered — «я из 23303, какие пары завтра» works in one go.
    const named = findGroupByNumber(db, text);

    if (named.asked && !named.group) {
        return answer(`Не нашла группу ${named.asked}. Назовите номер ещё раз — пять цифр, например 23101.`, { isLoggedIn });
    }

    const stored = (isLoggedIn && state.user?.group_id ? state.user : null) || (state.application?.group_id ? state.application : null);
    const group = named.group
        || (stored ? db.prepare('SELECT id, name FROM groups_ WHERE id = ?').get(stored.group_id) : null);

    if (!group) {
        const greeting = session.new ? 'Привет! Я подскажу расписание. ' : '';
        return answer(`${greeting}Назовите номер вашей группы, например 23101.`, { isLoggedIn });
    }

    const remember = named.group ? group : null;
    const prefix = named.group ? `Запомнила: группа ${group.name}. ` : '';

    if (/следующ\w* недел/.test(text)) {
        const monday = addDaysToIsoDate(today, 8 - weekdayOf(today));
        return answer(prefix + describeWeek(db, group.id, monday, today), { remember, isLoggedIn });
    }

    if (/недел/.test(text)) {
        const monday = addDaysToIsoDate(today, 1 - weekdayOf(today));
        return answer(prefix + describeWeek(db, group.id, monday, today), { remember, isLoggedIn });
    }

    const date = requestedDate(request, text, today);

    if (date) {
        return answer(prefix + describeDay(db, group.id, date, today), { remember, isLoggedIn });
    }

    // Nothing asked for in particular: today — or, once today's pairs are
    // over (evening), tomorrow, which is what someone asking then wants.
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayItems = dayItems(db, group.id, today);
    const last = todayItems.reduce((latest, item) => ((item.time_end || item.time_start) > latest ? (item.time_end || item.time_start) : latest), '');

    if (todayItems.length > 0 && last > nowTime) {
        return answer(prefix + describeDay(db, group.id, today, today), { remember, isLoggedIn });
    }

    const lead = todayItems.length > 0 ? 'Сегодня пары уже закончились. ' : '';
    return answer(prefix + lead + describeDay(db, group.id, addDaysToIsoDate(today, 1), today), { remember, isLoggedIn });
}

module.exports = { handleAlice };
