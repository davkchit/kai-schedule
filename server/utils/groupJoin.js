// Joined groups: two group numbers that study as one, e.g. 23313 joined to
// 23303. The member keeps its own row (students find "23313", their saved
// choice keeps working), but owns no pairs: its timetable IS the leader's.
// groups_.joined_to points from the member to the leader; one level only.

const COMPARED_LESSON_FIELDS = [
    'semester_id', 'subgroup', 'day_of_week', 'week_type', 'specific_week', 'template_from_week', 'is_removed',
    'time_start', 'time_end', 'subject', 'room', 'lesson_type', 'teacher', 'teacher_id', 'discipline_id', 'kind'
];

/** The group whose pairs this group shows: its leader when joined, else itself. */
function scheduleGroupId(db, groupId) {
    const row = db.prepare('SELECT joined_to FROM groups_ WHERE id = ?').get(groupId);
    return row && row.joined_to ? row.joined_to : groupId;
}

/** leader id → "23303 / 23313" for every group that has members. */
function joinedLabels(db) {
    const rows = db.prepare('SELECT id, name, joined_to FROM groups_').all();
    const names = new Map(rows.map((row) => [row.id, row.name]));
    const byLeader = new Map();

    for (const row of rows) {
        if (row.joined_to) {
            const list = byLeader.get(row.joined_to) || [names.get(row.joined_to)];
            list.push(row.name);
            byLeader.set(row.joined_to, list);
        }
    }

    return new Map([...byLeader].map(([leaderId, list]) => [leaderId, list.sort((a, b) => a.localeCompare(b, 'ru')).join(' / ')]));
}

/** Refusal text when a write names a member group, or null. Its pairs live in the leader. */
function joinedMemberError(db, groupId) {
    const row = db.prepare(`
        SELECT g.name, l.name AS leader_name FROM groups_ g JOIN groups_ l ON l.id = g.joined_to WHERE g.id = ?
    `).get(groupId);

    return row ? `Группа ${row.name} объединена с ${row.leader_name} — расписание у них общее, правьте его в ${row.leader_name}.` : null;
}

const lessonSignature = (lesson) => COMPARED_LESSON_FIELDS.map((field) => lesson[field] ?? '').join('\u0001');

/**
 * Joins `memberId` to `leaderId`. The member's own pairs must be the leader's
 * pairs exactly (or none at all) — then they are dropped as duplicates. Any
 * difference refuses the join, so nothing the specialist entered is lost
 * silently. Returns { removed } or throws an Error with statusCode.
 */
function joinGroup(db, memberId, leaderId) {
    const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
    const member = db.prepare('SELECT id, name, joined_to FROM groups_ WHERE id = ?').get(memberId);
    const leader = db.prepare('SELECT id, name, joined_to FROM groups_ WHERE id = ?').get(leaderId);

    if (!member || !leader) {
        throw fail('Группа не найдена', 404);
    }

    if (memberId === leaderId) {
        throw fail('Группу нельзя объединить саму с собой', 400);
    }

    if (leader.joined_to) {
        throw fail(`${leader.name} сама объединена с другой группой — выберите ту, главную`);
    }

    if (db.prepare('SELECT 1 FROM groups_ WHERE joined_to = ? LIMIT 1').get(memberId)) {
        throw fail(`С ${member.name} уже объединены другие группы — объединяйте их с ней, а не её с ${leader.name}`);
    }

    const memberLessons = db.prepare('SELECT * FROM lessons WHERE group_id = ?').all(memberId);
    const closed = db.prepare(`
        SELECT DISTINCT s.label FROM lessons l JOIN semesters s ON s.id = l.semester_id
        WHERE l.group_id = ? AND s.closed_at IS NOT NULL
    `).all(memberId);

    if (closed.length > 0) {
        throw fail(`У ${member.name} есть пары в закрытом семестре (${closed.map((row) => row.label).join(', ')}) — его не меняем`);
    }

    const leaderSignatures = new Map();

    for (const lesson of db.prepare('SELECT * FROM lessons WHERE group_id = ?').all(leaderId)) {
        const key = lessonSignature(lesson);
        leaderSignatures.set(key, (leaderSignatures.get(key) || 0) + 1);
    }

    const memberSignatures = new Map();

    for (const lesson of memberLessons) {
        const key = lessonSignature(lesson);
        memberSignatures.set(key, (memberSignatures.get(key) || 0) + 1);
    }

    if (memberLessons.length > 0) {
        const differing = [...new Set([...leaderSignatures.keys(), ...memberSignatures.keys()])]
            .reduce((sum, key) => sum + Math.abs((leaderSignatures.get(key) || 0) - (memberSignatures.get(key) || 0)), 0);

        if (differing > 0) {
            throw fail(`Расписания ${member.name} и ${leader.name} различаются (${differing} пар не совпадает) — сначала сделайте их одинаковыми, иначе часть пар пропадёт`);
        }
    }

    db.transaction(() => {
        db.prepare('DELETE FROM lessons WHERE group_id = ?').run(memberId);
        db.prepare('UPDATE groups_ SET joined_to = ? WHERE id = ?').run(leaderId, memberId);
    })();

    return { removed: memberLessons.length };
}

/**
 * Splits a member off again. It gets a copy of the shared timetable — of
 * every semester, closed ones included: while joined, those pairs WERE its
 * timetable, and without the copy its students would find last semester
 * empty. Nothing in a closed semester changes for anyone (its hours are the
 * stored totals). From then on the two groups can drift apart.
 */
function unjoinGroup(db, memberId) {
    const member = db.prepare('SELECT id, joined_to FROM groups_ WHERE id = ?').get(memberId);

    if (!member || !member.joined_to) {
        return { copied: 0 };
    }

    const rows = db.prepare(`
        SELECT * FROM lessons WHERE group_id = ?
    `).all(member.joined_to);
    const insert = db.prepare(`
        INSERT INTO lessons (
            group_id, semester_id, subgroup, day_of_week, week_type, specific_week, template_from_week, is_removed,
            time_start, time_end, subject, room, lesson_type, teacher, teacher_id, discipline_id, sort_order, kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    db.transaction(() => {
        for (const row of rows) {
            insert.run(
                memberId, row.semester_id, row.subgroup, row.day_of_week, row.week_type, row.specific_week,
                row.template_from_week, row.is_removed, row.time_start, row.time_end, row.subject, row.room,
                row.lesson_type, row.teacher, row.teacher_id, row.discipline_id, row.sort_order, row.kind
            );
        }

        db.prepare('UPDATE groups_ SET joined_to = NULL WHERE id = ?').run(memberId);
    })();

    return { copied: rows.length };
}

module.exports = { joinGroup, joinedLabels, joinedMemberError, scheduleGroupId, unjoinGroup };
