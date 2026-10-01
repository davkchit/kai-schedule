// A load_plan row covers one group or a stream of several (e.g. 23303 / 23313).
// load_plan.group_id holds the first group; the others live in
// load_plan_extra_groups. Everything that reads or writes a row's groups goes
// through here, so "which groups does this row cover" has one answer.

/** Every group id of a plan row, its own group_id first. */
function getPlanGroupIds(db, planRow) {
    const extras = db.prepare('SELECT group_id FROM load_plan_extra_groups WHERE plan_id = ?')
        .all(planRow.id)
        .map((row) => row.group_id);

    return [planRow.group_id, ...extras.filter((groupId) => groupId !== planRow.group_id)];
}

/**
 * Adds group_ids and a group_name label ("23303 / 23313", by name) to plan
 * rows. One query for all of them, so a listing of a whole semester stays cheap.
 */
function attachPlanGroups(db, planRows) {
    if (planRows.length === 0) {
        return planRows;
    }

    const groupNames = new Map(db.prepare('SELECT id, name FROM groups_').all().map((group) => [group.id, group.name]));
    const extrasByPlan = new Map();

    for (const row of db.prepare('SELECT plan_id, group_id FROM load_plan_extra_groups').all()) {
        const list = extrasByPlan.get(row.plan_id) || [];
        list.push(row.group_id);
        extrasByPlan.set(row.plan_id, list);
    }

    return planRows.map((row) => {
        const groupIds = [row.group_id, ...(extrasByPlan.get(row.id) || []).filter((groupId) => groupId !== row.group_id)];
        const names = groupIds.map((groupId) => groupNames.get(groupId) || '?')
            .sort((a, b) => a.localeCompare(b, 'ru'));

        return { ...row, group_ids: groupIds, group_name: names.join(' / ') };
    });
}

/** Replaces a row's groups: the first id becomes load_plan.group_id, the rest extras. */
function setPlanGroups(db, planId, groupIds) {
    db.prepare('UPDATE load_plan SET group_id = ? WHERE id = ?').run(groupIds[0], planId);
    db.prepare('DELETE FROM load_plan_extra_groups WHERE plan_id = ?').run(planId);
    const insert = db.prepare('INSERT INTO load_plan_extra_groups (plan_id, group_id) VALUES (?, ?)');

    for (const groupId of groupIds.slice(1)) {
        insert.run(planId, groupId);
    }
}

module.exports = { attachPlanGroups, getPlanGroupIds, setPlanGroups };
