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
