import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import usePageAssets from '../hooks/usePageAssets';
import { capitalize, formatLocalDateForApi, normalizeDate } from '../lib/date';
import ErrorScreen from '../components/ErrorScreen';
import { clearSelection, getSavedSelection, getSavedTheme, saveTheme } from '../lib/storage';
import { resolveLessonsForDay } from '../lib/scheduleResolve';
import {
    maxIso,
    planInitialWindow,
    parseIsoDate,
    requestDays,
    shiftIsoDate
} from '../lib/scheduleWindow';

// How far ahead the calendar lets you browse: the end of the month one year
// from today. It used to be a fixed date (31.12.2026), which would have left
// students with an empty schedule for the whole spring semester — a limit tied
// to the calendar has to move with it.
function getMaxDate() {
    const today = new Date();
    return new Date(today.getFullYear() + 1, today.getMonth() + 1, 0);
}

// Browsing back is bounded like browsing forward: a year either side of today.
// Nothing older is worth a timetable, and an unbounded strip would keep asking
// the server for empty weeks for as long as somebody kept scrolling.
function getMinDate() {
    const today = new Date();
    return new Date(today.getFullYear() - 1, today.getMonth(), 1);
}

const MAX_DATE = getMaxDate();
const MIN_DATE = getMinDate();
const WINDOW_LIMITS = {
    earliest: formatLocalDateForApi(MIN_DATE),
    latest: formatLocalDateForApi(MAX_DATE)
};
const CALENDAR_HEADERS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const BRAND_LOGO_SRC = '/assets/logo-trim.png';
// How long a pair that appeared or vanished in a live update animates — must
// cover the lesson-leave / lesson-enter keyframes in schedule.css.
const LESSON_MOTION_MS = 500;
const REST_DAY_GIF_SRC = '/assets/party-confetti.gif';

// Local development only: /schedule?preview=error shows the error screen
// without breaking anything. Production builds drop it (DEV is false there).
const PREVIEW_ERROR = import.meta.env.DEV
    && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('preview') === 'error';

const LOAD_FAILED = 'load-failed';
const NO_CONNECTION = 'no-connection';

// Display only: the stored lesson_type 'Лаб' must stay as is, it's part of how a pair matches its load-plan row.
const LESSON_TYPE_LABELS = { 'Лаб': 'Лаб.' };

// A bare number is a room; named places like "с/з" or "КАМАЗ" are shown as they are.
// A pair held online has «онлайн» for its room (the constructor's «Онлайн» box
// writes exactly that); it gets its own orange tag instead of a room number.
function isOnlineRoom(room) {
    return /^\s*(онлайн|online|дистанционно)\s*$/i.test(room || '');
}

function formatRoom(room) {
    const trimmed = room.trim();
    return /^\d+[а-яa-z]?$/i.test(trimmed) ? `${trimmed} каб.` : trimmed;
}

export default function SchedulePage() {
    const isAssetsReady = usePageAssets({
        title: 'Расписание занятий',
        description: 'Расписание занятий для студентов. Просмотр пар по дням недели.',
        stylesheets: ['/css/schedule.css', '/css/schedule-mobile.css']
    });

    const navigate = useNavigate();
    const dateSelectorRef = useRef(null);
    const burgerMenuRef = useRef(null);
    const scheduleGridRef = useRef(null);
    const dayTabsRef = useRef(null);

    const [savedSelection, setSavedSelection] = useState(() => getSavedSelection());
    const [currentDate, setCurrentDate] = useState(() => normalizeDate(new Date()));
    const [pickerDate, setPickerDate] = useState(() => normalizeDate(new Date()));
    const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);
    // What is on screen: a window of consecutive days [from, to] (ISO dates) around
    // the chosen day, the /api/schedule response that covers it, and a token that
    // changes whenever the window is rebuilt around a date.
    const [schedule, setSchedule] = useState(null);
    const scheduleData = schedule ? schedule.data : null;
    // 'YYYY-MM' of the day at the left edge of the strip, once the reader scrolls.
    const [visibleMonth, setVisibleMonth] = useState(null);
    // Mobile list view: how many days before the chosen date it also shows.
    const [listExtraDays, setListExtraDays] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState('');
    const [isSupportVisible, setIsSupportVisible] = useState(true);
    const [isMobileView, setIsMobileView] = useState(() => window.matchMedia('(max-width: 768px)').matches);
    const [currentView, setCurrentView] = useState('day');
    const [isBurgerOpen, setIsBurgerOpen] = useState(false);
    const [activeMobileTab, setActiveMobileTab] = useState('');
    const [isDark, setIsDark] = useState(() => getSavedTheme() === 'dark');
    const [refreshKey, setRefreshKey] = useState(0);
    // Shown over the timetable when a refresh failed but the previously loaded
    // schedule is still on screen — better than replacing it with an error.
    const [staleNotice, setStaleNotice] = useState('');
    const lastFetchTimeRef = useRef(0);
    const scheduleRef = useRef(null);
    scheduleRef.current = schedule;
    const currentDateRef = useRef(currentDate);
    currentDateRef.current = currentDate;
    // The calendar day the page last saw — see rollOverToNewDay.
    const todayIsoRef = useRef(formatLocalDateForApi(new Date()));

    // An app left open or in the background overnight still held yesterday
    // as the chosen day: a student opening it in the morning saw yesterday's
    // pairs. When the date has changed, a reader who was on "today" follows it
    // to the new today; one who picked another date keeps it. Returns whether
    // the day changed (the schedule is then reloaded around the new day).
    function rollOverToNewDay() {
        const todayIso = formatLocalDateForApi(new Date());

        if (todayIso === todayIsoRef.current) {
            return false;
        }

        const wasOnToday = formatLocalDateForApi(currentDateRef.current) === todayIsoRef.current;
        todayIsoRef.current = todayIso;

        if (wasOnToday) {
            setCurrentDate(normalizeDate(new Date()));
        }

        setRefreshKey((k) => k + 1);
        return true;
    }
    const anchorCounterRef = useRef(0);

    useEffect(() => {
        const selection = getSavedSelection();

        if (!selection?.group_id) {
            navigate('/', { replace: true });
            return;
        }

        // The same group as the one already held must not replace it: a new object
        // with identical contents restarts the load effect, and every visit to the
        // page then asks the server for the schedule twice.
        setSavedSelection((previous) => (
            previous
            && previous.group_id === selection.group_id
            && (previous.subgroup || 0) === (selection.subgroup || 0)
                ? previous
                : selection
        ));
    }, [navigate]);

    useEffect(() => {
        const mediaQuery = window.matchMedia('(max-width: 768px)');

        function handleMediaChange(event) {
            setIsMobileView(event.matches);
        }

        setIsMobileView(mediaQuery.matches);

        if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener('change', handleMediaChange);
        } else {
            mediaQuery.addListener(handleMediaChange);
        }

        return () => {
            if (mediaQuery.removeEventListener) {
                mediaQuery.removeEventListener('change', handleMediaChange);
            } else {
                mediaQuery.removeListener(handleMediaChange);
            }
        };
    }, []);

    useEffect(() => {
        function handleOutsideClick(event) {
            if (isDatePickerOpen && dateSelectorRef.current && !dateSelectorRef.current.contains(event.target)) {
                setIsDatePickerOpen(false);
            }

            if (isBurgerOpen && burgerMenuRef.current && !burgerMenuRef.current.contains(event.target)) {
                setIsBurgerOpen(false);
            }
        }

        document.addEventListener('mousedown', handleOutsideClick);

        return () => {
            document.removeEventListener('mousedown', handleOutsideClick);
        };
    }, [isBurgerOpen, isDatePickerOpen]);

    useEffect(() => {
        setActiveMobileTab(`day-${normalizeDate(currentDate).getTime()}`);
    }, [currentDate]);

    useEffect(() => {
        if (!savedSelection?.group_id) {
            return undefined;
        }

        const groupId = savedSelection.group_id;
        const subgroup = savedSelection.subgroup || 0;
        const wantedIso = formatLocalDateForApi(currentDate);
        const loaded = scheduleRef.current;
        const alreadyLoaded = loaded
            && loaded.groupId === groupId
            && loaded.subgroup === subgroup
            && loaded.refreshKey === refreshKey
            && wantedIso >= loaded.from
            && wantedIso <= loaded.to;

        if (alreadyLoaded) {
            // The day is inside the run already on screen, so picking it only
            // scrolls there. Tapping through a week used to fire one request per
            // tap — with a whole campus behind a single address, that is what
            // actually generates the load.
            return undefined;
        }

        const { from, to } = planInitialWindow(wantedIso, WINDOW_LIMITS);
        let ignore = false;

        async function loadSchedule() {
            setIsLoading(true);
            setErrorMessage('');

            try {
                const data = await fetchScheduleWindow(groupId, subgroup, from, to);

                if (!ignore) {
                    anchorCounterRef.current += 1;
                    setSchedule({ groupId, subgroup, refreshKey, from, to, anchorToken: anchorCounterRef.current, data });
                    setListExtraDays(0);
                    setStaleNotice('');
                    lastFetchTimeRef.current = Date.now();
                }
            } catch (error) {
                if (ignore) {
                    return;
                }

                // Keep whatever is already on screen. A rate-limited or failing
                // server used to blank the page even though the phone was
                // holding a perfectly good copy of the schedule.
                if (scheduleRef.current) {
                    setStaleNotice(
                        error.status === 429
                            ? 'Сервер сейчас загружен — показываем сохранённое расписание'
                            : navigator.onLine
                                ? 'Не удалось обновить — показываем сохранённое расписание'
                                : 'Нет связи — показываем сохранённое расписание'
                    );
                } else {
                    setErrorMessage(
                        navigator.onLine ? LOAD_FAILED : NO_CONNECTION
                    );
                }
            } finally {
                if (!ignore) {
                    setIsLoading(false);
                }
            }
        }

        loadSchedule();

        return () => {
            ignore = true;
        };
    }, [currentDate, savedSelection, refreshKey]);

    // Puts the chosen day at the left edge whenever the window is rebuilt around
    // it, a different day is picked, or the layout changes.
    useLayoutEffect(() => {
        if (!schedule || isLoading || !isAssetsReady) {
            return;
        }

        const iso = formatLocalDateForApi(currentDate);

        if (iso < schedule.from || iso > schedule.to) {
            return;
        }

        if (!isMobileView) {
            alignToElement(scheduleGridRef.current, `[data-date="${iso}"]`);
        } else if (currentView === 'day') {
            // The day the reader last tapped comes first: after a refresh that
            // is the one they were looking at, not necessarily today.
            alignToElement(dayTabsRef.current, `[data-target-id="${activeMobileTab}"]`)
                || alignToElement(dayTabsRef.current, `[data-date="${iso}"]`);
        }
        // Re-aligns only when the date, the run or the layout changes, never on an ordinary render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentDate, schedule?.anchorToken, isLoading, isAssetsReady, isMobileView, currentView]);

    useEffect(() => {
        const grid = scheduleGridRef.current;
        if (!grid) return;

        let isDown = false;
        let startX = 0;
        let scrollLeft = 0;

        function onMouseDown(e) {
            isDown = true;
            startX = e.clientX;
            scrollLeft = grid.scrollLeft;
            grid.style.cursor = 'grabbing';
        }

        function onMouseUp() {
            if (!isDown) return;
            isDown = false;
            grid.style.cursor = 'grab';
        }

        function onMouseMove(e) {
            if (!isDown) return;
            grid.scrollLeft = scrollLeft - (e.clientX - startX);
        }

        grid.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);

        return () => {
            grid.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
        };
    }, [isAssetsReady]);

    // Desktop: watches the strip's horizontal scroll to keep the date button on
    // the month of the day at the left edge.
    useEffect(() => {
        const grid = scheduleGridRef.current;

        if (!grid || isMobileView) {
            return undefined;
        }

        let frame = 0;

        function inspect() {
            frame = 0;
            const columns = grid.querySelectorAll('.day-column');

            if (columns.length === 0) {
                return;
            }

            const first = columns[0].getBoundingClientRect();

            if (!first.width) {
                return;
            }

            // The day at the left edge is the first column at least half in view.
            const scrolledAway = grid.getBoundingClientRect().left - first.left;
            const index = Math.min(columns.length - 1, Math.max(0, Math.round(scrolledAway / first.width)));
            const leftDate = columns[index].dataset.date;

            if (leftDate) {
                setVisibleMonth(leftDate.slice(0, 7));
            }

        }

        function onScroll() {
            if (!frame) {
                frame = requestAnimationFrame(inspect);
            }
        }

        grid.addEventListener('scroll', onScroll, { passive: true });

        return () => {
            grid.removeEventListener('scroll', onScroll);

            if (frame) {
                cancelAnimationFrame(frame);
            }
        };
    }, [isAssetsReady, isMobileView]);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    }, [isDark]);

    useEffect(() => {
        function handleVisibilityChange() {
            if (document.visibilityState !== 'visible' || rollOverToNewDay()) {
                return;
            }

            if (Date.now() - lastFetchTimeRef.current > 60_000) {
                setRefreshKey((k) => k + 1);
            }
        }
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    }, []);

    // While the page stays open and visible, re-read the same window once a
    // minute, so a pair the specialist removes disappears without a relaunch.
    // Unlike refreshKey this is silent: same days, no loading state, no
    // re-anchoring — the reader's scroll position and chosen day stay put, and
    // nothing re-renders at all when the schedule hasn't changed. A hidden
    // page (app in the background, phone locked) sends nothing.
    useEffect(() => {
        const timer = window.setInterval(async () => {
            const loaded = scheduleRef.current;

            if (document.visibilityState !== 'visible' || rollOverToNewDay()) {
                return; // hidden, or midnight passed with the page open: reloaded around the new day
            }

            if (!loaded || Date.now() - lastFetchTimeRef.current < 55_000) {
                return;
            }

            try {
                // 'no-cache' revalidates with the server instead of reusing the
                // browser's copy from up to a minute ago.
                const data = await fetchScheduleWindow(loaded.groupId, loaded.subgroup, loaded.from, loaded.to, 'no-cache');

                if (scheduleRef.current !== loaded) {
                    return; // the reader moved to another window meanwhile
                }

                lastFetchTimeRef.current = Date.now();

                if (JSON.stringify(data) !== JSON.stringify(loaded.data)) {
                    // previousData lets buildScheduleDays keep a cancelled pair
                    // on screen just long enough to animate it away (and mark a
                    // new one to animate in); then it is dropped.
                    setSchedule({ ...loaded, data, previousData: loaded.data });
                    window.setTimeout(() => {
                        setSchedule((current) => (current && current.data === data && current.previousData
                            ? { ...current, previousData: null }
                            : current));
                    }, LESSON_MOTION_MS);
                }
            } catch {
                // Keep what is on screen; the next tick tries again.
            }
        }, 60_000);

        return () => window.clearInterval(timer);
    }, []);

    const scheduleDays = useMemo(() => buildScheduleDays(schedule), [schedule]);
    const calendarDays = buildCalendarDays(pickerDate, currentDate);

    // The list view on a phone starts at the chosen day. Earlier days are added
    // by a button rather than by scrolling up: the page header sits above the
    // list, and days appearing there would push it out of the reader's reach.
    const currentIso = formatLocalDateForApi(currentDate);
    const listStartIso = schedule
        ? maxIso(shiftIsoDate(currentIso, -listExtraDays), schedule.from)
        : currentIso;
    const gridDays = isMobileView ? scheduleDays.filter((day) => day.iso >= listStartIso) : scheduleDays;
    const canShowEarlierDays = Boolean(schedule) && listStartIso > schedule.from;

    // The date button names the month of the day at the left edge of the strip,
    // which is what the reader is looking at, not the day they once picked.
    const labelDate = visibleMonth
        ? new Date(Number(visibleMonth.slice(0, 4)), Number(visibleMonth.slice(5, 7)) - 1, 1)
        : currentDate;
    const dateSelectorText = capitalize(
        labelDate.toLocaleString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '')
    );
    const currentMonthYear = capitalize(
        pickerDate.toLocaleString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '')
    );
    const isNextMonthDisabled =
        pickerDate.getFullYear() === MAX_DATE.getFullYear() &&
        pickerDate.getMonth() === MAX_DATE.getMonth();
    const isPrevMonthDisabled =
        pickerDate.getFullYear() === MIN_DATE.getFullYear() &&
        pickerDate.getMonth() === MIN_DATE.getMonth();

    function showEarlierDays() {
        setListExtraDays(listExtraDays + 14);
    }

    function switchSchedule() {
        clearSelection();
        navigate('/', { replace: true });
    }

    function toggleTheme() {
        setIsDark((previous) => {
            const next = !previous;
            saveTheme(next ? 'dark' : 'light');
            return next;
        });
    }

    function toggleDatePicker() {
        setPickerDate(new Date(labelDate.getFullYear(), labelDate.getMonth(), 1));
        setIsDatePickerOpen((previous) => !previous);
    }

    function shiftPickerMonth(offset) {
        setPickerDate((previous) => {
            const next = new Date(previous.getFullYear(), previous.getMonth() + offset, 1);

            if (next < MIN_DATE) {
                return previous;
            }

            if (
                next.getFullYear() > MAX_DATE.getFullYear() ||
                (next.getFullYear() === MAX_DATE.getFullYear() && next.getMonth() > MAX_DATE.getMonth())
            ) {
                return previous;
            }

            return next;
        });
    }

    function goToPreviousMonth() {
        shiftPickerMonth(-1);
    }

    function goToNextMonth() {
        shiftPickerMonth(1);
    }

    function toggleMobileView() {
        if (!isMobileView) {
            return;
        }

        setCurrentView((previous) => (previous === 'list' ? 'day' : 'list'));
        setIsBurgerOpen(false);
    }

    // A pair that just appeared or vanished in a live update is wrapped for
    // its animation: the wrapper's height opens or closes (so the pairs below
    // glide instead of jumping) while the card itself fades. Once the motion
    // is over it renders bare again, like every other pair.
    function renderLessonCard(lesson, mobile = false) {
        const card = renderLessonCardBody(lesson, mobile);

        if (!lesson.motion) {
            return card;
        }

        return (
            <div
                className={`lesson-motion is-${lesson.motion}`}
                key={`${lesson.id}-${lesson.motion}${mobile ? '-mobile' : ''}`}
                aria-hidden={lesson.motion === 'leaving' ? 'true' : undefined}
            >
                <div className="lesson-motion-inner">{card}</div>
            </div>
        );
    }

    function renderLessonCardBody(lesson, mobile) {
        const subgroupTag = lesson.subgroup > 0
            ? <span className={mobile ? 'mobile-tag-subgroup' : 'tag-subgroup'}>{lesson.subgroup} подгр.</span>
            : null;
        const roomTag = !lesson.room
            ? null
            : isOnlineRoom(lesson.room)
                ? (
                    <span className={`${mobile ? 'mobile-tag-room' : 'tag-room'} tag-online`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="4" y="5" width="16" height="11" rx="1.5" />
                            <path d="M2 19h20" />
                        </svg>
                        Онлайн
                    </span>
                )
                : <span className={mobile ? 'mobile-tag-room' : 'tag-room'}>{formatRoom(lesson.room)}</span>;
        const typeTag = lesson.lesson_type
            ? <span className={mobile ? 'mobile-tag-type' : 'tag-type'}>{LESSON_TYPE_LABELS[lesson.lesson_type] || lesson.lesson_type}</span>
            : null;
        // Same look as the room and type tags, in the same row; it moves to a row
        // of its own only when there is no room left. title shows a name cut short.
        const teacherTag = lesson.teacher
            ? <span className={mobile ? 'mobile-tag-room tag-teacher' : 'tag-room tag-teacher'} title={lesson.teacher}>{lesson.teacher}</span>
            : null;

        if (mobile) {
            return (
                <div className="mobile-class-card" key={`${lesson.id}-mobile`}>
                    <div className="mobile-card-time">{lesson.time_start}—{lesson.time_end}</div>
                    <div className="mobile-card-subject">{lesson.subject}</div>
                    <div className="mobile-card-meta">
                        {roomTag}
                        {typeTag}
                        {subgroupTag}
                        {teacherTag}
                    </div>
                </div>
            );
        }

        return (
            <div className="class-card" key={lesson.id}>
                <div className="card-time">{lesson.time_start}—{lesson.time_end}</div>
                <div className="card-subject">{lesson.subject}</div>
                <div className="card-meta">
                    {roomTag}
                    {typeTag}
                    {subgroupTag}
                    {teacherTag}
                </div>
            </div>
        );
    }

    function renderRestDayState(mobile = false) {
        return (
            <div className={`rest-day ${mobile ? 'mobile' : ''}`}>
                <svg className="rest-day-sparkle rest-day-sparkle-left" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z" />
                </svg>
                <svg className="rest-day-sparkle rest-day-sparkle-right" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 2L14.2 9.8L22 12L14.2 14.2L12 22L9.8 14.2L2 12L9.8 9.8L12 2Z" />
                </svg>
                <span className="rest-day-icon">
                    <img
                        className="rest-day-confetti"
                        src={REST_DAY_GIF_SRC}
                        alt=""
                        aria-hidden="true"
                    />
                </span>
                <span className="rest-day-text">
                    <span className="rest-day-title">Отдыхаем</span>
                    <span className="rest-day-subtitle">Занятий нет</span>
                </span>
            </div>
        );
    }

    if (!isAssetsReady) {
        return null;
    }

    return (
        <div className="app-container">
            <header className="main-header">
                <div className="logo-area">
                    <img src={BRAND_LOGO_SRC} alt="Логотип КАИ" width="110" height="23" />
                </div>
                <h1 className="page-title desktop-only">
                    {savedSelection?.group_name ? `Расписание группы ${savedSelection.group_name}` : 'Расписание занятий'}
                </h1>
                {/* On a phone the header says whose schedule this is instead —
                    the page itself already makes "расписание" obvious. Just a
                    label: switching groups stays in the burger menu. */}
                {savedSelection?.group_name && (
                    <p className="header-group mobile-only">
                        <span className="header-group-name">Группа {savedSelection.group_name}</span>
                    </p>
                )}
                <div className="header-controls">
                    <a
                        href="/"
                        className="schedule-switch-btn desktop-only"
                        id="switchScheduleBtnDesktop"
                        onClick={(event) => {
                            event.preventDefault();
                            switchSchedule();
                        }}
                    >
                        Выбрать другое расписание
                    </a>
                    <button
                        className="theme-toggle desktop-only"
                        onClick={toggleTheme}
                        aria-label={isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
                    >
                        {isDark ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="5" />
                                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                            </svg>
                        ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                            </svg>
                        )}
                        <span className="toggle-track"><span className="toggle-thumb" /></span>
                    </button>
                    <div className="burger-menu-container mobile-only" ref={burgerMenuRef}>
                        <button className="burger-btn" id="burgerBtn" onClick={() => setIsBurgerOpen((previous) => !previous)}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="3" y1="12" x2="21" y2="12"></line>
                                <line x1="3" y1="6" x2="21" y2="6"></line>
                                <line x1="3" y1="18" x2="21" y2="18"></line>
                            </svg>
                        </button>
                        <div className={`burger-dropdown ${isBurgerOpen ? 'active' : ''}`} id="burgerDropdown">
                            <button className="dropdown-item schedule-switch-action" onClick={switchSchedule}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9"></path>
                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                                </svg>
                                Выбрать другое расписание
                            </button>
                            <button className="dropdown-item" id="toggleViewBtn" onClick={toggleMobileView}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                    <line x1="3" y1="9" x2="21" y2="9"></line>
                                    <line x1="9" y1="21" x2="9" y2="9"></line>
                                </svg>
                                Сменить вид расписания
                            </button>
                            <button className="dropdown-item theme-dropdown-item" onClick={toggleTheme}>
                                <div className="theme-dropdown-left">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                                    </svg>
                                    Тёмная тема
                                </div>
                                <span className="toggle-track"><span className="toggle-thumb" /></span>
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            <div className="toolbar">
                <div className="date-selector-wrapper" ref={dateSelectorRef}>
                    <button
                        type="button"
                        className="date-selector"
                        id="dateSelectorBtn"
                        onClick={toggleDatePicker}
                        aria-haspopup="dialog"
                        aria-expanded={isDatePickerOpen}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                            <line x1="16" y1="2" x2="16" y2="6"></line>
                            <line x1="8" y1="2" x2="8" y2="6"></line>
                            <line x1="3" y1="10" x2="21" y2="10"></line>
                        </svg>
                        <span id="dateSelectorText">{dateSelectorText}</span>
                    </button>
                    <div
                        className={`dp-scrim ${isDatePickerOpen ? 'active' : ''}`}
                        aria-hidden="true"
                        onClick={() => setIsDatePickerOpen(false)}
                    />
                    <div
                        className={`date-picker-popup ${isDatePickerOpen ? 'active' : ''}`}
                        id="datePickerPopup"
                        role="dialog"
                        aria-label="Выбор даты"
                        aria-hidden={!isDatePickerOpen}
                    >
                        <div className="dp-header">
                            <button
                                type="button"
                                className="dp-nav-btn"
                                id="prevMonthBtn"
                                onClick={goToPreviousMonth}
                                aria-label="Предыдущий месяц"
                                disabled={isPrevMonthDisabled}
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="15 18 9 12 15 6"></polyline>
                                </svg>
                            </button>
                            <div className="dp-title-row" id="currentMonthYear" aria-live="polite">{currentMonthYear}</div>
                            <button
                                type="button"
                                className="dp-nav-btn"
                                id="nextMonthBtn"
                                onClick={goToNextMonth}
                                aria-label="Следующий месяц"
                                disabled={isNextMonthDisabled}
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="9 18 15 12 9 6"></polyline>
                                </svg>
                            </button>
                        </div>
                        <div className="dp-grid">
                            {CALENDAR_HEADERS.map((label) => (
                                <div className="dp-day-header" key={label}>{label}</div>
                            ))}
                        </div>
                        <div className="dp-grid" id="calendarGrid">
                            {calendarDays.map((item) => {
                                if (item.type === 'empty') {
                                    return <div className="dp-empty-cell" key={item.key} aria-hidden="true"></div>;
                                }

                                return (
                                    <button
                                        type="button"
                                        key={item.key}
                                        className={`dp-day ${item.isSelected ? 'selected' : ''} ${item.isToday ? 'today' : ''}`}
                                        disabled={item.isDisabled}
                                        aria-pressed={item.isSelected}
                                        aria-label={item.date.toLocaleString('ru-RU', {
                                            day: 'numeric',
                                            month: 'long',
                                            year: 'numeric'
                                        })}
                                        onClick={() => {
                                            setCurrentDate(item.date);
                                            setVisibleMonth(null);
                                            setListExtraDays(0);
                                            setIsDatePickerOpen(false);
                                        }}
                                    >
                                        {item.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            <div
                className="schedule-grid-wrap"
                style={isMobileView && currentView === 'day' ? { display: 'none' } : undefined}
            >
                <main
                    className="schedule-grid"
                    id="desktopSchedule"
                    ref={scheduleGridRef}
                    onWheel={(event) => {
                        if (isMobileView) {
                            return;
                        }

                        const grid = event.currentTarget;
                        const scrollContainer = grid.closest('.app-container') || grid.parentElement;
                        const hasVerticalOverflow = scrollContainer.scrollHeight > scrollContainer.clientHeight + 1;

                        if (hasVerticalOverflow) {
                            return;
                        }

                        grid.scrollLeft += event.deltaY;
                    }}
                >
                    {isLoading && (
                        <div className="schedule-loading">
                            <div className="loading-spinner"></div>
                            Загрузка...
                        </div>
                    )}

                    {!isLoading && staleNotice && scheduleData && (
                        <div className="schedule-stale" role="status">{staleNotice}</div>
                    )}
                    {!isLoading && scheduleData && isMobileView && canShowEarlierDays && (
                        <button
                            type="button"
                            className="load-earlier-btn"
                            onClick={showEarlierDays}
                        >
                            Показать предыдущие дни
                        </button>
                    )}
                    {!isLoading && scheduleData && gridDays.map((day) => (
                        <div className="day-column" key={day.id} data-date={day.iso}>
                            <div className="day-header">
                                <div className={`day-badge ${day.isToday ? '' : 'hidden'}`}>Сегодня</div>
                                <div className="day-title">{day.title}</div>
                                <div className="day-time">{day.timeRange}</div>
                            </div>
                            {day.isRestDay && (
                                renderRestDayState()
                            )}
                            {!day.isRestDay && day.lessons.map((lesson) => renderLessonCard(lesson))}
                        </div>
                    ))}
                </main>
            </div>

            <div
                className="mobile-day-view"
                style={isMobileView && currentView === 'day' ? { display: 'flex' } : { display: 'none' }}
            >
                <div className="day-tabs-container">
                    <div className="day-tabs" id="mobileDayTabs" ref={dayTabsRef}>
                        {scheduleDays.map((day) => (
                            <button
                                key={day.id}
                                className={`day-tab ${activeMobileTab === day.id ? 'active' : ''} ${day.isToday ? 'is-today' : ''}`}
                                data-target-id={day.id}
                                data-date={day.iso}
                                onClick={() => setActiveMobileTab(day.id)}
                            >
                                <div className="day-tab-name">{day.shortName}</div>
                                <div className="day-tab-date">{day.shortDate}</div>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="day-content" id="mobileDayContent">
                    {/* The phone's day view used to stay blank while loading and
                        on a failure: both messages lived only in the grid above,
                        which this view hides. */}
                    {!scheduleData && isLoading && (
                        <div className="schedule-loading">
                            <div className="loading-spinner"></div>
                            Загрузка...
                        </div>
                    )}
                    {scheduleDays.map((day) => (
                        <div
                            key={`${day.id}-content`}
                            className={`day-schedule ${activeMobileTab === day.id ? 'active' : ''}`}
                            id={day.id}
                        >
                            {day.isRestDay && (
                                renderRestDayState(true)
                            )}
                            {!day.isRestDay && day.lessons.map((lesson) => renderLessonCard(lesson, true))}
                        </div>
                    ))}
                </div>
            </div>

            {isSupportVisible && (
                <div className="support-widget">
                    <div className="support-icon">
                        <img src={BRAND_LOGO_SRC} alt="Логотип КАИ" width="56" height="12" />
                    </div>
                    <div className="support-text">
                        <div className="support-title">Есть вопросы?</div>
                        <div className="support-subtitle">Напишите нам</div>
                    </div>
                    <button
                        type="button"
                        className="close-support"
                        aria-label="Закрыть"
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsSupportVisible(false);
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                </div>
            )}

            {/* Nothing to show and the load failed: the full-page error, with
                the way out — the same load asked for again, or back to the
                group search. */}
            {((!isLoading && errorMessage && !scheduleData) || PREVIEW_ERROR) && (
                <ErrorScreen
                    text={errorMessage === NO_CONNECTION
                        ? ['Нет подключения к интернету.', 'Проверьте связь и обновите страницу.']
                        : ['Не удалось загрузить расписание.', 'Попробуйте обновить страницу через несколько секунд.']}
                    onRetry={() => setRefreshKey((k) => k + 1)}
                    onHome={switchSchedule}
                />
            )}
        </div>
    );
}

async function fetchScheduleWindow(groupId, subgroup, from, to, cacheMode = 'default') {
    const response = await fetch(
        `/api/schedule/${groupId}?subgroup=${subgroup}&date=${from}&days=${requestDays(from, to)}`,
        { cache: cacheMode }
    );

    if (!response.ok) {
        const error = new Error('Failed to fetch schedule');
        error.status = response.status;
        throw error;
    }

    return response.json();
}

/** Scrolls a horizontal strip so the element matching `selector` sits at its left edge. */
function alignToElement(container, selector) {
    if (!container) {
        return false;
    }

    const target = container.querySelector(selector);

    if (!target) {
        return false;
    }

    container.scrollLeft += target.getBoundingClientRect().left - container.getBoundingClientRect().left;

    return true;
}

/**
 * One day's pairs across a live update: the new pairs, plus the pairs that
 * just disappeared (marked 'leaving', kept only while they animate out);
 * pairs in a slot that was empty before are marked 'entering'. A slot is its
 * time and subgroup — an edited pair keeps its slot, so it simply updates in
 * place instead of fading out and back in.
 */
function withLessonMotion(previousLessons, nextLessons) {
    const slotOf = (lesson) => `${lesson.time_start}|${lesson.time_end}|${lesson.subgroup || 0}`;
    const previousSlots = new Set(previousLessons.map(slotOf));
    const nextSlots = new Set(nextLessons.map(slotOf));

    const current = nextLessons.map((lesson) => (
        previousSlots.has(slotOf(lesson)) ? lesson : { ...lesson, motion: 'entering' }
    ));
    const leaving = previousLessons
        .filter((lesson) => !nextSlots.has(slotOf(lesson)))
        .map((lesson) => ({ ...lesson, motion: 'leaving' }));

    return [...current, ...leaving].sort((a, b) => a.time_start.localeCompare(b.time_start));
}

function buildScheduleDays(schedule) {
    if (!schedule) {
        return [];
    }

    const scheduleData = schedule.data;
    const today = normalizeDate(new Date());
    const result = [];
    const last = parseIsoDate(schedule.to);

    let iterDate = parseIsoDate(schedule.from);

    while (iterDate <= last && iterDate <= MAX_DATE) {
        // Semester, week number, parity and "week with its own rows" are all
        // decided in src/lib/scheduleResolve.js, the same code the year
        // lifecycle test runs.
        const lessons = schedule.previousData
            ? withLessonMotion(resolveLessonsForDay(schedule.previousData, iterDate), resolveLessonsForDay(scheduleData, iterDate))
            : resolveLessonsForDay(scheduleData, iterDate);

        // Any day without pairs gets the same «Отдыхаем · Занятий нет» card —
        // a weekday used to show a bare «Нет занятий» line instead.
        const isRestDay = lessons.length === 0;
        const timeRange = lessons.length
            ? `${lessons[0].time_start}—${lessons[lessons.length - 1].time_end}`
            : '';
        const dateId = `day-${iterDate.getTime()}`;

        result.push({
            id: dateId,
            iso: formatLocalDateForApi(iterDate),
            date: new Date(iterDate),
            isToday: iterDate.getTime() === today.getTime(),
            title: capitalize(
                iterDate.toLocaleString('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                    weekday: 'short'
                })
            ),
            shortName: iterDate.toLocaleString('ru-RU', { weekday: 'short' }),
            shortDate: `${String(iterDate.getDate()).padStart(2, '0')}.${String(iterDate.getMonth() + 1).padStart(2, '0')}`,
            lessons,
            timeRange,
            isRestDay
        });

        iterDate = new Date(iterDate);
        iterDate.setDate(iterDate.getDate() + 1);
    }

    return result;
}

function buildCalendarDays(pickerDate, currentDate) {
    const year = pickerDate.getFullYear();
    const month = pickerDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const startOffset = (firstDayOfWeek + 6) % 7;
    const today = normalizeDate(new Date());
    const result = [];

    for (let index = 0; index < startOffset; index += 1) {
        result.push({ type: 'empty', key: `empty-${index}` });
    }

    for (let day = 1; day <= daysInMonth; day += 1) {
        const date = normalizeDate(new Date(year, month, day));

        result.push({
            type: 'day',
            key: `day-${day}`,
            label: day,
            date,
            isSelected: date.getTime() === currentDate.getTime(),
            isToday: date.getTime() === today.getTime(),
            isDisabled: date > MAX_DATE
        });
    }

    return result;
}
