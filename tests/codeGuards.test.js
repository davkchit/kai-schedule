const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Checks on the source itself for bug classes that tests of behaviour can only
// catch once the calendar actually reaches them.

function listSourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listSourceFiles(full);
        return /\.(js|jsx)$/.test(entry.name) ? [full] : [];
    });
}

test('no hard-coded calendar dates in application logic', () => {
    // The student schedule once capped browsing at a literal 31 Dec 2026, which
    // would have shown an empty timetable for the whole spring semester — and
    // nothing fails until that day arrives. Dates the app reasons about must
    // come from data (semesters, settings) or from the clock.
    const root = path.join(__dirname, '..');
    const files = [...listSourceFiles(path.join(root, 'server')), ...listSourceFiles(path.join(root, 'src'))]
        .filter((file) => !/seed/i.test(path.basename(file)));
    const datePattern = /new Date\(\s*20\d\d\s*,|Date\.UTC\(\s*20\d\d|['"`]20\d\d-\d\d-\d\d['"`]/;
    const offenders = [];

    for (const file of files) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            const code = line.replace(/\/\/.*$/, '');
            if (datePattern.test(code)) {
                offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
            }
        });
    }

    assert.deepEqual(offenders, []);
});

test('every audit action the server writes has a Russian label in the journal', () => {
    // The journal showed raw codes like "semester.close" and "lesson.move" for
    // the actions nobody had added to the label map — the specialist reads
    // this page, not the code.
    const root = path.join(__dirname, '..');
    const actions = new Set();
    for (const file of listSourceFiles(path.join(root, 'server'))) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/action:\s*(?:[^?,\n]+\?\s*)?'([a-z_]+\.[a-z_]+)'(?:\s*:\s*'([a-z_]+\.[a-z_]+)')?/g)) {
            actions.add(match[1]);
            if (match[2]) actions.add(match[2]);
        }
    }
    const labels = fs.readFileSync(path.join(root, 'src', 'pages', 'adminDashboard', 'format.js'), 'utf8');
    const missing = [...actions].filter((action) => !labels.includes(`'${action}':`));

    assert.ok(actions.size > 10, `found only ${actions.size} audit actions — the pattern no longer matches the code`);
    assert.deepEqual(missing, [], `no label for: ${missing.join(', ')}`);
});
