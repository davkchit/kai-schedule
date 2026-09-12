import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import usePageAssets from '../hooks/usePageAssets';
import { getSavedSelection, saveSelection } from '../lib/storage';

const STEPS = [
    {
        subtitle: 'Выберите Ваш университет',
        placeholder: 'Например КНИТУ-КАИ'
    },
    {
        subtitle: 'Отлично. Теперь номер вашей группы',
        placeholder: 'Например 23113'
    },
    {
        subtitle: 'А теперь выберите вашу подгруппу',
        placeholder: 'Например 1'
    }
];

const SUBGROUP_OPTIONS = ['1 подгруппа', '2 подгруппа'];

export default function WelcomePage() {
    const isAssetsReady = usePageAssets({
        title: 'Найдите своё расписание',
        description: 'Расписание занятий для студентов КНИТУ-КАИ. Выберите группу и подгруппу.',
        stylesheets: ['/css/welcome.css']
    });

    const navigate = useNavigate();
    const subtitleTimersRef = useRef([]);

    const [currentStep, setCurrentStep] = useState(0);
    const [subtitle, setSubtitle] = useState(STEPS[0].subtitle);
    const [subtitleAnimationClass, setSubtitleAnimationClass] = useState('');
    const [universities, setUniversities] = useState([]);
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

                if (!ignore) {
                    setUniversities(Array.isArray(data) ? data : []);
                }
            } catch {
                if (!ignore) {
                    setUniversities([]);
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

    useEffect(() => {
        return () => {
            for (const timer of subtitleTimersRef.current) {
                window.clearTimeout(timer);
            }
        };
    }, []);

    const suggestions = getSuggestions(currentStep, universities, groups, inputValue);

    function animateSubtitle(nextSubtitle) {
        for (const timer of subtitleTimersRef.current) {
            window.clearTimeout(timer);
        }

        subtitleTimersRef.current = [];
        setSubtitleAnimationClass('fade-out');

        const changeTimer = window.setTimeout(() => {
            setSubtitle(nextSubtitle);
            setSubtitleAnimationClass('fade-in');

            const cleanupTimer = window.setTimeout(() => {
                setSubtitleAnimationClass('');
            }, 400);

            subtitleTimersRef.current.push(cleanupTimer);
        }, 300);

        subtitleTimersRef.current.push(changeTimer);
    }

    function flashValidationError() {
        setIsInvalid(true);
        window.setTimeout(() => setIsInvalid(false), 500);
    }

    function moveToStep(stepIndex) {
        setCurrentStep(stepIndex);
        animateSubtitle(STEPS[stepIndex].subtitle);
        setShowSuggestions(true);
    }

    function handleBack() {
        if (currentStep === 0) {
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
        animateSubtitle('Отлично! Ищем ваше расписание...');
        saveSelection(selection);

        window.setTimeout(() => {
            navigate('/schedule', { replace: true });
        }, 800);
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

            setFormData((previous) => ({
                ...previous,
                group_id: selectedGroup.id,
                group_name: selectedGroup.name,
                subgroup: ''
            }));
            setInputValue('');
            moveToStep(2);
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
        <div>
            <div className="background-circles">
                <div className="circle circle-1"></div>
                <div className="circle circle-2"></div>
                <div className="circle circle-3"></div>
                <div className="circle circle-4"></div>
            </div>

            <div className="container">
                <div className="card">
                    <div className="icon">
                        <img src="/assets/logo.png" alt="Логотип КАИ" width="180" height="75" />
                    </div>

                    <h1 className="title">Найдите своё расписание</h1>

                    <p className={`subtitle ${subtitleAnimationClass}`} id="subtitle">
                        {subtitle}
                    </p>

                    <form id="scheduleForm" onSubmit={handleSubmit}>
                        <button
                            type="button"
                            id="backButton"
                            className={`back-button ${currentStep === 0 || isFinishing ? 'hidden' : ''}`}
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
                                id="searchInput"
                                className="search-input"
                                placeholder={STEPS[currentStep].placeholder}
                                autoComplete="off"
                                value={inputValue}
                                disabled={isFinishing}
                                onChange={(event) => {
                                    setInputValue(event.target.value);
                                    setShowSuggestions(true);
                                }}
                                onFocus={() => setShowSuggestions(true)}
                                onBlur={() => {
                                    window.setTimeout(() => setShowSuggestions(false), 200);
                                }}
                                style={isInvalid ? { borderColor: '#EF4444' } : undefined}
                            />
                            <button type="submit" className="search-button" aria-label="Далее" disabled={isFinishing}>
                                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M9 17A8 8 0 1 0 9 1a8 8 0 0 0 0 16zM19 19l-4.35-4.35" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </button>
                            <div
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

                </div>

                {currentStep === 0 && (
                    <button type="button" className="teacher-link" onClick={() => navigate('/teacher')}>
                        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path d="M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 17.5c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>Я преподаватель</span>
                        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path d="M4 10h12M11 5l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
}

function getSuggestions(currentStep, universities, groups, inputValue) {
    let options = [];

    if (currentStep === 0) {
        options = universities.map((university) => university.short_name);
    } else if (currentStep === 1) {
        options = groups.map((group) => group.name);
    } else {
        options = SUBGROUP_OPTIONS;
    }

    if (!inputValue.trim()) {
        return options;
    }

    return options.filter((option) =>
        option.toLowerCase().includes(inputValue.trim().toLowerCase())
    );
}
