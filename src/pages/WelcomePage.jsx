import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuroraBackground from '../components/AuroraBackground';
import usePageAssets from '../hooks/usePageAssets';
import { getSavedSelection, saveSelection } from '../lib/storage';

// What each step asks lives in the field itself — no grey line under the title.
const STEPS = [
    { placeholder: 'Вуз, например КНИТУ-КАИ' },
    { placeholder: 'Номер группы' },
    { placeholder: 'Подгруппа, например 1' }
];

const SUBGROUP_OPTIONS = ['1 подгруппа', '2 подгруппа'];

export default function WelcomePage() {
    const isAssetsReady = usePageAssets({
        title: 'Найдите своё расписание',
        description: 'Расписание занятий для студентов КНИТУ-КАИ. Выберите группу и подгруппу.',
        stylesheets: ['/css/welcome.css']
    });

    const navigate = useNavigate();

    const [currentStep, setCurrentStep] = useState(0);
    const [universities, setUniversities] = useState([]);
    const [isUniversityLoaded, setIsUniversityLoaded] = useState(false);
    const [isSingleUniversity, setIsSingleUniversity] = useState(false);
    const [groups, setGroups] = useState([]);
    const [formData, setFormData] = useState({
        university_id: null,
        university_name: '',
        group_id: null,
        group_name: '',
        subgroup: ''
    });
    const [inputValue, setInputValue] = useState('');
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [isInvalid, setIsInvalid] = useState(false);
    const [isFinishing, setIsFinishing] = useState(false);
    const [isInputFocused, setIsInputFocused] = useState(false);
    const inputRef = useRef(null);
    const listRef = useRef(null);

    useEffect(() => {
        const savedSelection = getSavedSelection();

        if (savedSelection?.group_id && savedSelection?.subgroup) {
            navigate('/schedule', { replace: true });
        }
    }, [navigate]);

    useEffect(() => {
        let ignore = false;

        async function loadUniversities() {
            try {
                const response = await fetch('/api/universities');
                const data = await response.json();

                if (ignore) {
                    return;
                }

                const list = Array.isArray(data) ? data : [];
                setUniversities(list);
                setIsUniversityLoaded(true);

                if (list.length === 1) {
                    setIsSingleUniversity(true);
                    setFormData((previous) => ({
                        ...previous,
                        university_id: list[0].id,
                        university_name: list[0].short_name
                    }));
                    // With only one university there is nothing to choose:
                    // the page opens straight on the group step.
                    setCurrentStep(1);
                }
            } catch {
                if (!ignore) {
                    setUniversities([]);
                    setIsUniversityLoaded(true);
                }
            }
        }

        if (currentStep === 0 && universities.length === 0) {
            loadUniversities();
        }

        return () => {
            ignore = true;
        };
    }, [currentStep, universities.length]);

    useEffect(() => {
        let ignore = false;

        async function loadGroups() {
            try {
                const response = await fetch(`/api/universities/${formData.university_id}/groups`);
                const data = await response.json();

                if (!ignore) {
                    setGroups(Array.isArray(data) ? data : []);
                }
            } catch {
                if (!ignore) {
                    setGroups([]);
                }
            }
        }

        if (currentStep === 1 && formData.university_id) {
            loadGroups();
        }

        return () => {
            ignore = true;
        };
    }, [currentStep, formData.university_id]);

    const suggestions = getSuggestions(currentStep, universities, groups, inputValue);
    // The step the page starts on: the group one when the university was picked for you.
    const firstStep = isSingleUniversity ? 1 : 0;
    // Until the universities arrive the field already asks for the usual thing, a group.
    // The example in the hint is a real group, picked at random on every visit —
    // a made-up number sent people looking for a group that doesn't exist.
    const exampleGroup = useMemo(
        () => (groups.length > 0 ? groups[Math.floor(Math.random() * groups.length)].name : ''),
        [groups]
    );
    const placeholder = currentStep === 1 || !isUniversityLoaded
        ? (exampleGroup ? `Номер группы, например ${exampleGroup}` : STEPS[1].placeholder)
        : STEPS[currentStep].placeholder;
    // Group numbers and subgroups are digits: a phone shows its number pad,
    // which is shorter than the letters and needs no switching.
    const isNumericStep = currentStep === 2 ||
        (currentStep === 1 && groups.length > 0 && groups.every((group) => /^\d+$/.test(group.name)));

    // On a phone the keyboard covers the lower half of the screen, and the
    // field sits mid-card with the list running under the keyboard. While the
    // field is focused the page gets room below (.keyboard-open), the field is
    // scrolled to the top of what is visible, and the list is cut to the space
    // left above the keyboard.
    useEffect(() => {
        if (!isInputFocused) {
            return undefined;
        }

        const viewport = window.visualViewport;
        const isPhone = window.matchMedia('(max-width: 768px)').matches;
        const root = document.documentElement;
        const list = listRef.current;
        // Measured before the keyboard is up: Chrome on Android shrinks innerHeight with it.
        const fullHeight = window.innerHeight;

        let wasKeyboardShown = false;

        function fitList() {
            if (!list || !viewport) {
                return;
            }

            const keyboardShown = viewport.height < fullHeight - 80;

            if (!keyboardShown) {
                wasKeyboardShown = false;
                list.style.maxHeight = '';
                return;
            }

            // The keyboard came up after the first scroll aimed at the full screen.
            if (!wasKeyboardShown && isPhone) {
                wasKeyboardShown = true;
                inputRef.current?.scrollIntoView({ block: 'start' });
            }

            const visibleBottom = viewport.offsetTop + viewport.height;
            const room = visibleBottom - list.getBoundingClientRect().top - 12;
            list.style.maxHeight = `${Math.max(112, Math.round(room))}px`;
        }

        let scrollTimer = null;

        if (isPhone) {
            root.classList.add('keyboard-open');
            // After the keyboard has slid in, or the scroll would aim at the old viewport.
            scrollTimer = window.setTimeout(() => {
                inputRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                window.setTimeout(fitList, 350);
            }, 300);
        }

        fitList();
        viewport?.addEventListener('resize', fitList);
        viewport?.addEventListener('scroll', fitList);

        return () => {
            window.clearTimeout(scrollTimer);
            root.classList.remove('keyboard-open');
            viewport?.removeEventListener('resize', fitList);
            viewport?.removeEventListener('scroll', fitList);

            if (list) {
                list.style.maxHeight = '';
            }
        };
    }, [isInputFocused]);

    function flashValidationError() {
        setIsInvalid(true);
        window.setTimeout(() => setIsInvalid(false), 500);
    }

    function moveToStep(stepIndex) {
        setCurrentStep(stepIndex);
        setShowSuggestions(true);
    }

    function handleBack() {
        if (currentStep <= firstStep) {
            return;
        }

        const nextStep = currentStep - 1;
        moveToStep(nextStep);

        if (nextStep === 0) {
            setInputValue(formData.university_name);
        } else if (nextStep === 1) {
            setInputValue(formData.group_name);
        }
    }

    function finishSelection(selection) {
        setIsFinishing(true);
        setShowSuggestions(false);
        saveSelection(selection);

        // A breath to see the choice land in the field, then the schedule fades in.
        window.setTimeout(() => {
            navigate('/schedule', { replace: true });
        }, 250);
    }

    function processValue(trimmedValue) {
        if (!trimmedValue) {
            flashValidationError();
            return;
        }

        if (currentStep === 0) {
            const selectedUniversity = universities.find(
                (university) => university.short_name === trimmedValue
            );

            if (!selectedUniversity) {
                flashValidationError();
                return;
            }

            setFormData((previous) => ({
                ...previous,
                university_id: selectedUniversity.id,
                university_name: selectedUniversity.short_name,
                group_id: null,
                group_name: '',
                subgroup: ''
            }));
            setGroups([]);
            setInputValue('');
            moveToStep(1);
            return;
        }

        if (currentStep === 1) {
            const selectedGroup = groups.find((group) => group.name === trimmedValue);

            if (!selectedGroup) {
                flashValidationError();
                return;
            }

            // No subgroup step: no pair uses subgroups, so the whole group is
            // shown. "0" = whole group; a non-empty value also marks the
            // selection complete for the redirect on the next visit.
            const nextSelection = {
                ...formData,
                group_id: selectedGroup.id,
                group_name: selectedGroup.name,
                subgroup: '0'
            };

            setFormData(nextSelection);
            finishSelection(nextSelection);
            return;
        }

        const subgroupMatch = trimmedValue.match(/(\d)/);
        const subgroup = subgroupMatch ? subgroupMatch[1] : trimmedValue;

        if (!['1', '2'].includes(subgroup)) {
            flashValidationError();
            return;
        }

        const nextSelection = {
            ...formData,
            subgroup
        };

        setFormData(nextSelection);
        finishSelection(nextSelection);
    }

    function handleSubmit(event) {
        event.preventDefault();
        processValue(inputValue.trim());
    }

    function selectSuggestion(option) {
        setInputValue(option);
        processValue(option);
    }

    if (!isAssetsReady) {
        return null;
    }

    return (
        <div className="page-stack">
            <header className="page-logo">
                <img src="/assets/logo-trim.png" alt="Логотип КАИ" width="180" height="38" />
            </header>

            <AuroraBackground />

            <div className="container">
                <div className="card">
                    <h1 className="title">Найдите своё расписание</h1>

                    <form id="scheduleForm" onSubmit={handleSubmit}>
                        <button
                            type="button"
                            id="backButton"
                            className={`back-button ${currentStep <= firstStep || isFinishing ? 'hidden' : ''}`}
                            onClick={handleBack}
                        >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M10 12L6 8L10 4" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            Назад
                        </button>

                        <div className="search-container">
                            <input
                                type="text"
                                ref={inputRef}
                                id="searchInput"
                                className="search-input"
                                placeholder={placeholder}
                                autoComplete="off"
                                value={inputValue}
                                disabled={isFinishing}
                                onChange={(event) => {
                                    setInputValue(event.target.value);
                                    setShowSuggestions(true);
                                }}
                                inputMode={isNumericStep ? 'numeric' : 'text'}
                                enterKeyHint="next"
                                onFocus={() => {
                                    setShowSuggestions(true);
                                    setIsInputFocused(true);
                                }}
                                onBlur={() => {
                                    setIsInputFocused(false);
                                    window.setTimeout(() => setShowSuggestions(false), 200);
                                }}
                                style={isInvalid ? { borderColor: '#EF4444' } : undefined}
                            />
                            <button type="submit" className="search-button" aria-label="Далее" disabled={isFinishing}>
                                <svg width="22" height="22" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16zM19 19l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </button>
                            <div
                                ref={listRef}
                                id="suggestions"
                                className={`suggestions-list ${!showSuggestions || suggestions.length === 0 || isFinishing ? 'hidden' : ''}`}
                            >
                                {suggestions.map((option) => (
                                    <div
                                        key={option}
                                        className="suggestion-item"
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            selectSuggestion(option);
                                        }}
                                    >
                                        {option}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </form>

                    {/* The second way in: a quiet blue link under the search. */}
                    {currentStep === firstStep && !isFinishing && (
                        <div className="teacher-entry">
                            <button type="button" className="teacher-link" onClick={() => navigate('/teacher')}>
                                Вы преподаватель?
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function getSuggestions(currentStep, universities, groups, inputValue) {
    const options = currentStep === 0
        ? universities.map((university) => university.short_name)
        : currentStep === 1
            ? groups.map((group) => group.name)
            : SUBGROUP_OPTIONS;

    if (!inputValue.trim()) {
        return options;
    }

    return options.filter((option) =>
        option.toLowerCase().includes(inputValue.trim().toLowerCase())
    );
}
