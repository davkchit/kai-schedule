// The Alice skill: «Алиса, спроси у КАИ расписания, какие пары завтра».
// Yandex Dialogs posts each phrase here (routes/api.js → POST /api/alice) and
// speaks the text we answer. Only reads the public schedule — exactly what
// the student page shows (utils/dayResolve.js) plus экзамены/зачёты — and
// remembers the student's group in the skill's own storage: per Yandex
// account when the user is logged in (user_state_update), otherwise per
// device (application_state). Nothing is written to our database.

const clock = require('./utils/clock');
const { addDaysToIsoDate, formatLocalDate, isValidIsoDate } = require('./utils/date');
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
// Month words by their stem, so a typo or a stray letter («сентябряя») still counts.
const MONTH_STEMS = [/^январ/, /^феврал/, /^март/, /^апрел/, /^ма[йяю]/, /^июн/, /^июл/, /^август/, /^сентябр/, /^октябр/, /^ноябр/, /^декабр/];
const monthOfWord = (word) => MONTH_STEMS.findIndex((stem) => stem.test(word)) + 1;
// «1 пара», «3-ей паре», «2-я пара»: Alice's command turns «первая» into a
// digit. A digit right before the singular «пара/пару/паре/парой», or with an
// ordinal ending, is which pair — not a date. «2 пары», «5 пар» (no ending)
// is a count and stays as it is.
const ORDINAL_DIGIT = /(?:^|\s)([1-8])(?:\s*-?\s*(?:я|ая|ой|ей|й|ю|ую|го|ом)\s+(?=пар|заняти|урок)|\s+(?=пара|пару|паре|парой))/;
const withoutOrdinal = (text) => text.replace(ORDINAL_DIGIT, ' ').replace(/\s+/g, ' ').trim();
const KIND_WORDS = { exam: 'экзамен', credit: 'зачёт', consultation: 'консультация' };
const BUTTONS = ['Сегодня', 'Завтра', 'Следующая пара', 'На неделе', 'Сменить группу'];
const ORDINALS = ['Первая', 'Вторая', 'Третья', 'Четвёртая', 'Пятая', 'Шестая', 'Седьмая', 'Восьмая'];
const ORDINALS_OF = ['первой', 'второй', 'третьей', 'четвёртой', 'пятой', 'шестой', 'седьмой', 'восьмой'];

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

/** What and where, without the time: «Математика, лекция, аудитория 305». */
function itemBody(item) {
    // «с/з» is how the sheets write the gym; spoken, it has to be a word.
    const room = !item.room ? ''
        : /^\s*(онлайн|online|дистанционно)\s*$/i.test(item.room) ? ', онлайн'
            : /^\s*с\/з\s*$/i.test(item.room) ? ', спортзал'
                : `, аудитория ${item.room}`;

    if (item.attestation) {
        return `${KIND_WORDS[item.kind] || 'экзамен'} по предмету ${item.subject}${room}`;
    }

    const type = item.kind === 'event' || !item.lesson_type ? '' : `, ${item.lesson_type.toLowerCase().replace('лаб', 'лабораторная')}`;
    return `${item.subject}${type}${room}`;
}

const isPair = (item) => !item.attestation && item.kind !== 'event';
const pairWord = (count) => plural(count, 'пара', 'пары', 'пар');
const lowerFirst = (text) => `${text[0].toLowerCase()}${text.slice(1)}`;

/**
 * One day, said the way a person would: past days in the past tense, pairs
 * by their order («Первая — в 8:00, …»), an event or an exam by its time.
 */
function describeDay(db, groupId, iso, today) {
    const items = dayItems(db, groupId, iso);
    const label = dayLabel(iso, today);
    const past = iso < today;

    if (items.length === 0) {
        return past ? `${label}, пар не было.` : `${label}, пар нет.`;
    }

    const pairs = items.filter(isPair).length;
    const head = pairs === 0 ? (past ? 'пар не было' : 'пар нет')
        : past ? `${plural(pairs, 'была', 'было', 'было')} ${pairs} ${pairWord(pairs)}` : `${pairs} ${pairWord(pairs)}`;
    let order = 0;
    const parts = items.map((item) => (isPair(item)
        ? `${ORDINALS[order++] || 'Ещё одна'} — в ${spokenTime(item.time_start)}, ${itemBody(item)}.`
        : `В ${spokenTime(item.time_start)} — ${itemBody(item)}.`));

    return `${label}, ${head}. ${parts.join(' ')}`;
}

/** «первая пара», «последняя пара», «сколько пар» about one day. */
function describePick(db, groupId, iso, today, pick) {
    const pairs = dayItems(db, groupId, iso).filter(isPair);
    const label = dayLabel(iso, today);
    const past = iso < today;

    if (pairs.length === 0) {
        return past ? `${label}, пар не было.` : `${label}, пар нет.`;
    }

    if (pick === 'count') {
        const last = pairs[pairs.length - 1];
        return `${label}, ${past ? `${plural(pairs.length, 'была', 'было', 'было')} ` : ''}${pairs.length} ${pairWord(pairs.length)}: с ${spokenTime(pairs[0].time_start)} до ${spokenTime(last.time_end || last.time_start)}.`;
    }

    if (pick === 'last') {
        const last = pairs[pairs.length - 1];
        const ends = last.time_end ? `, ${past ? 'закончилась' : 'закончится'} в ${spokenTime(last.time_end)}` : '';
        return `${label}, последняя пара — ${pairs.length > 1 ? `${lowerFirst(ORDINALS[pairs.length - 1] || 'ещё одна')}, ` : ''}в ${spokenTime(last.time_start)}: ${itemBody(last)}${ends}.`;
    }

    const pair = pairs[pick];

    if (!pair) {
        return `${label}, ${past ? 'было' : 'всего'} ${pairs.length} ${pairWord(pairs.length)} — ${ORDINALS_OF[pick] || 'такой'} пары ${past ? 'не было' : 'нет'}.`;
    }

    return `${label}, ${lowerFirst(ORDINALS[pick])} пара — в ${spokenTime(pair.time_start)}: ${itemBody(pair)}.`;
}

/** «какая сейчас пара», «следующая пара»: from this minute on, today and then the coming days. */
function describeNow(db, groupId, today, nowTime) {
    const pairs = dayItems(db, groupId, today).filter(isPair);
    const current = pairs.find((pair) => pair.time_start <= nowTime && nowTime < (pair.time_end || pair.time_start));
    const next = pairs.find((pair) => pair.time_start > nowTime);

    if (current) {
        const tail = next ? ` Следующая — в ${spokenTime(next.time_start)}, ${itemBody(next)}.` : ' Это последняя пара на сегодня.';
        return `Сейчас идёт ${itemBody(current)}${current.time_end ? `, до ${spokenTime(current.time_end)}` : ''}.${tail}`;
    }

    if (next) {
        return `Следующая пара — в ${spokenTime(next.time_start)}: ${itemBody(next)}.`;
    }

    for (let offset = 1; offset <= 14; offset += 1) {
        const iso = addDaysToIsoDate(today, offset);
        const first = dayItems(db, groupId, iso).filter(isPair)[0];
        if (first) {
            return `${pairs.length > 0 ? 'На сегодня пары закончились' : 'Сегодня пар нет'}. Ближайшая — ${lowerFirst(dayLabel(iso, today))}, в ${spokenTime(first.time_start)}: ${itemBody(first)}.`;
        }
    }

    return 'В ближайшие две недели пар нет.';
}

// Words that are about the question, not the subject asked for.
const QUESTION_WORDS = /^(когда|будет|будут|следующ|ближайш|сколько|аудитор|какой|какая|какие|котор|занят|пара|пары|пару|урок|лекци|практик|лаборат|меня|предмет|начина)/;

/** «когда физика», «где базы данных»: the subject's nearest pair (or exam) from now on. */
function describeSubject(db, groupId, text, today, nowTime) {
    const stems = text.split(' ').filter((word) => word.length >= 4 && !QUESTION_WORDS.test(word)).map((word) => word.slice(0, 5));

    if (stems.length === 0) {
        return null;
    }

    for (let offset = 0; offset <= 21; offset += 1) {
        const iso = addDaysToIsoDate(today, offset);
        const found = dayItems(db, groupId, iso).find((item) => {
            if (offset === 0 && (item.time_end || item.time_start) <= nowTime) return false;
            const subject = normalize(item.subject);
            return item.kind !== 'event' && stems.every((stem) => subject.includes(stem));
        });

        if (found && offset === 0 && found.time_start <= nowTime) {
            return `Идёт прямо сейчас${found.time_end ? `, до ${spokenTime(found.time_end)}` : ''}: ${itemBody(found)}.`;
        }

        if (found) {
            return `Ближайшее: ${lowerFirst(dayLabel(iso, today))}, в ${spokenTime(found.time_start)} — ${itemBody(found)}.`;
        }
    }

    return null;
}

/** «когда экзамены», «что на сессии»: the group's records from today on. */
function describeSession(db, groupId, today) {
    const records = selectAttestations(db, 'a.group_id = ? AND a.date >= ?', [scheduleGroupId(db, groupId), today])
        .sort((left, right) => (left.date + left.time_start).localeCompare(right.date + right.time_start));

    if (records.length === 0) {
        return 'Экзаменов, зачётов и консультаций пока не назначено.';
    }

    const shown = records.slice(0, 6).map((record) => {
        const [, month, day] = record.date.split('-').map(Number);
        return `${day} ${MONTHS[month - 1]} в ${spokenTime(record.time_start)} — ${itemBody({ ...record, attestation: true })}`;
    });
    const more = records.length > shown.length ? ` И ещё ${records.length - shown.length}.` : '';
    return `Впереди: ${shown.join('; ')}.${more}`;
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

/**
 * A day and month as the nearest such date — this year, or the neighbouring
 * one for «5 января» asked in December. Null if there is no such day.
 */
function nearestDate(day, month, today) {
    const year = Number(today.slice(0, 4));
    const pad = (value) => String(value).padStart(2, '0');
    const distance = (iso) => Math.abs(new Date(`${iso}T00:00:00Z`) - new Date(`${today}T00:00:00Z`));
    const candidates = [year - 1, year, year + 1].map((y) => `${y}-${pad(month)}-${pad(day)}`).filter(isValidIsoDate);
    return candidates.sort((left, right) => distance(left) - distance(right))[0] || null;
}

/**
 * The date a phrase asks about, or null: Alice's own date entity first, then
 * words. `contextMonth` is the month of the date asked just before (kept in
 * session_state), so «а 18?» right after «19 сентября» means 18 September.
 */
function requestedDate(request, text, today, contextMonth = null) {
    const entity = (request.nlu?.entities || []).find((item) => item.type === 'YANDEX.DATETIME')?.value;
    const fallbackMonth = contextMonth || Number(today.slice(5, 7));

    if (entity) {
        if (entity.day_is_relative && Number.isInteger(entity.day)) {
            return addDaysToIsoDate(today, entity.day);
        }

        if (Number.isInteger(entity.day)) {
            const month = Number.isInteger(entity.month) ? entity.month : fallbackMonth;
            const date = Number.isInteger(entity.year)
                ? `${entity.year}-${String(month).padStart(2, '0')}-${String(entity.day).padStart(2, '0')}`
                : nearestDate(entity.day, month, today);
            if (date && isValidIsoDate(date)) return date;
        }
    }

    // «16 октября», «19 сентябряя» — a number and a month word.
    for (const match of text.matchAll(/(?:^|\D)(\d{1,2})\s+([а-яё]+)/g)) {
        const month = monthOfWord(match[2]);
        if (month) return nearestDate(Number(match[1]), month, today);
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

    // A bare day, last: «а 18», «18-го», «18 число» — in the month just talked
    // about. Not a number of pairs («2 пары»), and only when nothing above
    // («завтра», «в пятницу») already named the day.
    const bare = text.match(/(?:^|\s)(\d{1,2})(?:\s*-?\s*(?:го|е|число|числа))?(?:\s|$)(?!\s*(?:пар|заняти|урок))/);
    if (bare && Number(bare[1]) >= 1 && Number(bare[1]) <= 31) {
        const date = nearestDate(Number(bare[1]), fallbackMonth, today);
        if (date) return date;
    }

    return null;
}

function findGroupByNumber(db, text) {
    // Speech often comes back split: «двадцать три сто один» → «23 101».
    // A whole five-digit number is taken as it is first: joining every digit
    // run would glue «23303 1 пара» into «233031».
    const match = text.match(/(?:^|\D)(\d{5})(?!\d)/) || text.replace(/(\d)\s+(?=\d)/g, '$1').match(/(?:^|\D)(\d{5})(?!\d)/);
    if (!match) return { asked: null, group: null };
    return { asked: match[1], group: db.prepare('SELECT id, name FROM groups_ WHERE name = ?').get(match[1]) || null };
}

function answer(text, { end = false, remember, forget = false, isLoggedIn, session = null } = {}) {
    const response = {
        version: '1.0',
        // Only for this conversation: the month last asked about, or a
        // question asked before the group was known.
        ...(session ? { session_state: session } : {}),
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
    + 'Потом спрашивайте как удобно: «что завтра», «первая пара в пятницу», «какая следующая пара», «во сколько я сегодня освобожусь», '
    + '«когда физика», «когда экзамены», «расписание на неделю». Сменить группу — «другая группа».';
const NOT_UNDERSTOOD = 'Не совсем поняла. Можно спросить, например: «что завтра», «первая пара в пятницу», «какая следующая пара», «когда экзамены».';

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

    if (/^(хватит|стоп|выход|выйти|закончить|все спасибо|спасибо все|пока|до свидания)$/.test(text)) {
        return answer('Хорошо, до встречи! Хорошего дня.', { end: true, isLoggedIn });
    }

    if (/^(спасибо|благодарю|спс)( большое| огромное)?$/.test(text)) {
        return answer('Пожалуйста! Обращайтесь, если что.', { end: true, isLoggedIn });
    }

    if (/помощь|что ты умеешь|что умеешь|как пользоваться|кто ты|ты кто/.test(text)) {
        return answer(HELP, { isLoggedIn });
    }

    // A word of small talk gets a word back, not a timetable.
    if (/как (у тебя )?(дела|ты|жизнь|настроение|поживаешь)/.test(text)) {
        return answer('Всё хорошо, спасибо, что спросили! Могу подсказать, что у вас сегодня или завтра.', { isLoggedIn });
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

    const contextMonth = Number.isInteger(state.session?.month) ? state.session.month : null;

    if (!group) {
        // A question asked before the group is known is answered once it is.
        const pendingWeek = /(?:^|[^а-яё])недел/.test(text) ? (/следующ[а-яё]*\s+недел/.test(text) ? 'next' : 'this') : null;
        const pendingDate = pendingWeek ? null : requestedDate(request, withoutOrdinal(text), today, contextMonth);
        const keep = pendingWeek || pendingDate ? { pending_week: pendingWeek, pending_date: pendingDate } : (state.session || null);
        const greeting = session.new ? 'Привет! Я подскажу расписание. ' : '';
        return answer(`${greeting}Назовите номер вашей группы, например 23101.`, { isLoggedIn, session: keep });
    }

    const remember = named.group ? group : null;
    const prefix = named.group ? `Запомнила: группа ${group.name}. ` : '';
    // The group number itself is not a date («23 303» is not «23-го»).
    const dateText = named.asked ? text.replace(/(\d)\s+(?=\d)/g, '$1').replace(named.asked, ' ').replace(/\s+/g, ' ').trim() : text;
    // Just the number given («23303», «я из группы 23303»): answer what was asked before it.
    const onlyGroup = named.group && dateText.split(' ').every((word) => !word || /^(я|из|моя|группа|группы|номер)$/.test(word));
    const pending = onlyGroup ? state.session : null;

    if (pending?.pending_date && isValidIsoDate(pending.pending_date)) {
        return answer(prefix + describeDay(db, group.id, pending.pending_date, today), { remember, isLoggedIn, session: { month: Number(pending.pending_date.slice(5, 7)) } });
    }

    if (pending?.pending_week) {
        const monday = addDaysToIsoDate(today, (pending.pending_week === 'next' ? 8 : 1) - weekdayOf(today));
        return answer(prefix + describeWeek(db, group.id, monday, today), { remember, isLoggedIn });
    }

    const greetingOnly = /^(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер|хай|алиса)$/.test(dateText);

    if (greetingOnly && !named.group) {
        return answer('Привет! Спросите, например: «что сегодня», «какая следующая пара» или «когда экзамены».', { isLoggedIn });
    }

    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (/экзамен|зачет|сесси|консультац/.test(dateText) && !requestedDate(request, dateText, today, contextMonth)) {
        return answer(prefix + describeSession(db, group.id, today), { remember, isLoggedIn });
    }

    if (/(следующ|ближайш)[а-яё]*\s+пар|(какая|что)\s+(сейчас|щас|теперь)|сейчас\s+пара|^(а )?сейчас$|^(а |ну )?(что |какая )?(дальше|потом|после)( пара)?$/.test(dateText)) {
        return answer(prefix + describeNow(db, group.id, today, nowTime), { remember, isLoggedIn });
    }

    // «недел» as the start of a word: «понедельник» contains it too. (JavaScript's
    // word classes know no Cyrillic, hence the explicit letter class.)
    if (/следующ[а-яё]*\s+недел/.test(text)) {
        const monday = addDaysToIsoDate(today, 8 - weekdayOf(today));
        return answer(prefix + describeWeek(db, group.id, monday, today), { remember, isLoggedIn });
    }

    if (/(?:^|[^а-яё])недел/.test(text)) {
        const monday = addDaysToIsoDate(today, 1 - weekdayOf(today));
        return answer(prefix + describeWeek(db, group.id, monday, today), { remember, isLoggedIn });
    }

    // Which pair. The command carries «первая» as «1»; the original phrase
    // still has the word, so only the ordinal WORD is also looked for there —
    // every other intent is read from the command alone, like the date.
    const nthWord = `${dateText} ${normalize(raw)}`.match(/(перв|втор|трет|четверт|пят|шест|седьм)[а-яё]*\s+(?:пар|заняти|урок)/);
    const nthDigit = dateText.match(ORDINAL_DIGIT);
    const pick = /сколько[а-яё ]*пар/.test(dateText) ? 'count'
        : nthWord ? ['перв', 'втор', 'трет', 'четв', 'пят', 'шест', 'седьм'].findIndex((stem) => nthWord[1].startsWith(stem))
            : nthDigit ? Number(nthDigit[1]) - 1
                : /последн[а-яё]*\s+пар|освобож|во сколько[а-яё ]*(закончи|заканчива|кончаю|конча)/.test(dateText) ? 'last'
                    : /во сколько[а-яё ]*(начина|первая|на учеб|к первой|вставать)|к скольки/.test(dateText) ? 0
                        : null;
    const date = requestedDate(request, withoutOrdinal(dateText), today, contextMonth);

    if (pick !== null) {
        const day = date || defaultDay(db, group.id, today, nowTime).iso;
        return answer(prefix + describePick(db, group.id, day, today, pick), { remember, isLoggedIn, session: { month: Number(day.slice(5, 7)) } });
    }

    if (date) {
        return answer(prefix + describeDay(db, group.id, date, today), { remember, isLoggedIn, session: { month: Number(date.slice(5, 7)) } });
    }

    if (/когда|где|во сколько|в какой/.test(dateText)) {
        const subject = describeSubject(db, group.id, dateText, today, nowTime);
        if (subject) return answer(prefix + subject, { remember, isLoggedIn });
    }

    // It sounded like a date, but none came out: say so, rather than quietly
    // answering about tomorrow as if that had been asked.
    if (/\d/.test(dateText) || dateText.split(' ').some((word) => monthOfWord(word))) {
        return answer(`${prefix}Не поняла, какой день. Скажите, например: «18 сентября», «в пятницу» или «завтра».`, { remember, isLoggedIn, session: state.session || null });
    }

    // A phrase about something else entirely: say what can be asked, rather
    // than reading out a timetable nobody asked for.
    if (dateText && !named.group && !greetingOnly && !/пар|расписан|заняти|учеб|урок|лекци|практик|^(а |ну )?(что|чего|дальше|ещ[её])( у (меня|нас))?$/.test(dateText)) {
        return answer(NOT_UNDERSTOOD, { isLoggedIn });
    }

    const { iso, lead } = defaultDay(db, group.id, today, nowTime);
    return answer(prefix + lead + describeDay(db, group.id, iso, today), { remember, isLoggedIn });
}

/**
 * Nothing asked for in particular: today — or, once today's pairs are over
 * (evening), tomorrow, which is what someone asking then wants.
 */
function defaultDay(db, groupId, today, nowTime) {
    const todayItems = dayItems(db, groupId, today);
    const last = todayItems.reduce((latest, item) => ((item.time_end || item.time_start) > latest ? (item.time_end || item.time_start) : latest), '');

    if (todayItems.length > 0 && last > nowTime) {
        return { iso: today, lead: '' };
    }

    return { iso: addDaysToIsoDate(today, 1), lead: todayItems.length > 0 ? 'Сегодня пары уже закончились. ' : '' };
}

module.exports = { handleAlice };
