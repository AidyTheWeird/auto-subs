import { useEffect, createContext, useState, useContext, useRef } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
import { BaseDirectory, readTextFile, exists, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { join, documentDir } from '@tauri-apps/api/path';
import { save } from '@tauri-apps/plugin-dialog';
import { Subtitle, Speaker, TopSpeaker } from "@/types/interfaces";
import { load, Store } from '@tauri-apps/plugin-store';
import { Child, Command } from '@tauri-apps/plugin-shell';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { platform } from '@tauri-apps/plugin-os';

let transcriptionProcess: Child | null = null;

interface GlobalContextProps {
    // home page
    timeline: string;
    trackList: Track[];
    templateList: Template[];
    currentTrack: string;
    currentTemplate: string;
    currentLanguage: string;
    model: string;
    translate: boolean;
    diarize: boolean;
    maxWords: number;
    maxChars: number;
    textFormat: string;
    removePunctuation: boolean;
    sensitiveWords: string;
    alignWords: boolean;
    processingStep: string;
    isLoading: boolean;
    error: ErrorMsg;
    audioPath: string;
    setError: (errorMsg: ErrorMsg) => void
    setIsLoading: (newIsLoading: boolean) => void;
    setTemplate: (newTemplate: string) => void;
    setLanguage: (newLanguage: string) => void;
    setTrack: (newTrack: string) => void;
    setModel: (newModel: string) => void;
    setTranslate: (newTranslate: boolean) => void;
    setDiarize: (newDiarize: boolean) => void;
    setMaxWords: (newMaxWords: number) => void;
    setMaxChars: (newMaxChars: number) => void;
    setTextFormat: (newTextFormat: string) => void;
    setRemovePunctuation: (newRemovePunctuation: boolean) => void;
    setSensitiveWords: (newSensitiveWords: string) => void;
    setAlignWords: (newAlignWords: boolean) => void;
    fetchTranscription: (audioPath: string) => Promise<void>;
    subtitles: Subtitle[];

    // edit page
    speakers: Speaker[];
    topSpeaker: TopSpeaker;
    setSpeakers: (newSpeakers: Speaker[]) => void;
    updateSpeaker: (index: number, label: string, color: string, style: string) => Promise<void>
    getTimelineInfo: () => Promise<void>;
    getTracks: () => Promise<void>;
    getTemplates: () => Promise<void>;
    populateSubtitles: (timelineId: string) => Promise<void>;
    addSubtitles: (filePath?: string) => Promise<void>;
    exportSubtitles: () => Promise<void>;
    initialize: () => void;
    jumpToTime: (start: number) => Promise<void>;
}

const resolveAPI = "http://localhost:55010/";
const transcribeAPI = "http://localhost:55000/transcribe/";
//const validateAPI = "http://localhost:55000/validate/";

let storageDir = '';

let store: Store | null = null;

const subtitleRegex = /\[\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}\.\d{3}\]\s+(.*)/;

interface Template {
    value: string;
    label: string;
}
interface Track {
    value: string;
    label: string;
}
interface ErrorMsg {
    title: string;
    desc: string;
}

const GlobalContext = createContext<GlobalContextProps | undefined>(undefined);

export function GlobalProvider({ children }: React.PropsWithChildren<{}>) {
    const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
    const [speakers, setSpeakers] = useState<Speaker[]>([]);
    const [templateList, setTemplateList] = useState<Template[]>([]);
    const [trackList, setTrackList] = useState<Track[]>([]);
    const [timeline, setTimeline] = useState<string>("");
    const [topSpeaker, setTopSpeaker] = useState<TopSpeaker>({ label: "", id: "", percentage: 0 });
    const [isLoading, setIsLoading] = useState(true);
    const [processingStep, setProcessingStep] = useState("Starting Transcription Server...");
    const [error, setError] = useState<ErrorMsg>({ title: "", desc: "" });
    const [audioPath, setAudioPath] = useState("");
    const serverLoading = useRef(true);

    const [markIn, setMarkIn] = useState(0);
    const [model, setModel] = useState("small");
    const [currentLanguage, setLanguage] = useState("en");
    const [currentTemplate, setTemplate] = useState("");
    const [currentTrack, setTrack] = useState("");
    const [translate, setTranslate] = useState(false);
    const [diarize, setDiarize] = useState(false);
    const [maxWords, setMaxWords] = useState(6);
    const [maxChars, setMaxChars] = useState(25);
    const [textFormat, setTextFormat] = useState("normal");
    const [removePunctuation, setRemovePunctuation] = useState(false);
    const [sensitiveWords, setSensitiveWords] = useState<string>("");
    const [alignWords, setAlignWords] = useState(false);

    async function setTranscriptsFolder() {
        storageDir = await join(await documentDir(), "AutoSubs");
        // create directory
        const dirExists = await exists(storageDir, { baseDir: BaseDirectory.Document });
        if (!dirExists) {
            await mkdir(storageDir, { baseDir: BaseDirectory.Document, recursive: true });
        }
    }

    async function getFullTranscriptPath() {
        let filePath = await join(storageDir, `${timeline}.json`);
        return filePath;
    }

    async function initializeStore() {
        if (!store) {
            store = await load('autosubs-store.json', { autoSave: false });
        }

        try {
            setModel(await store.get<string>('model') || "small");
            setLanguage(await store.get<string>('currentLanguage') || "en");
            setTemplate(await store.get<string>('currentTemplate') || "");
            setTrack(await store.get<string>('currentTrack') || "");
            setTranslate(await store.get<boolean>('translate') || false);
            setDiarize(await store.get<boolean>('diarize') || false);
            setMaxWords(await store.get<number>('maxWords') || 6);
            setMaxChars(await store.get<number>('maxChars') || 25);
            setTextFormat(await store.get<string>('textFormat') || "normal");
            setRemovePunctuation(await store.get<boolean>('removePunctuation') || false);
            setSensitiveWords(await store.get<string>('sensitiveWords') || "");
            setAlignWords(await store.get<boolean>('alignWords') || false);
        } catch (error) {
            console.error('Error initializing store:', error);
        }
    }

    async function saveState() {
        if (store) {
            try {
                await store.set('model', model);
                await store.set('currentLanguage', currentLanguage);
                await store.set('currentTemplate', currentTemplate);
                await store.set('currentTrack', currentTrack);
                await store.set('translate', translate);
                await store.set('diarize', diarize);
                await store.set('maxWords', maxWords);
                await store.set('maxChars', maxChars);
                await store.set('textFormat', textFormat);
                await store.set('removePunctuation', removePunctuation);
                await store.set('sensitiveWords', sensitiveWords);
                await store.set('alignWords', alignWords);
                await store.save(); // Persist changes
            } catch (error) {
                console.error('Error saving state:', error);
            }
        }
    }

    useEffect(() => {
        saveState();
    }, [model, currentLanguage, currentTemplate, currentTrack, translate, diarize, maxWords, maxChars, textFormat, removePunctuation]);

    async function startTranscriptionServer() {
        try {
            // Create the command without using 'open' or shell-specific arguments
            let command;
            if (platform() === 'windows') {
                command = Command.create('transcription-server-win');
            } else if (platform() === 'macos')
                command = Command.create('transcription-server-mac')
            else {
                return;
            }

            // Set up event listeners for logging
            command.on('close', (data) => {
                console.log(`Transcription server exited with code ${data.code} and signal ${data.signal}`);
            });

            command.on('error', (error) => {
                console.error(`Transcription server encountered an error: "${error}"`);
            });

            command.stdout.on('data', (line) => {
                const match = line.match(subtitleRegex);
                if (match && match[1]) {
                    let result = match[1].replace(/"/g, '').trim()
                    let subtitle = { text: result, start: "", end: "", speaker: "" };
                    setSubtitles(prevSubtitles => [subtitle, ...prevSubtitles]);
                    setProcessingStep("Transcribing Audio...");
                } else if (line.includes('Progress:')) {
                    const percentageMatch = line.match(/(\d+)%/);
                    if (percentageMatch && percentageMatch[1]) {
                        const percentage = parseInt(percentageMatch[1], 10);
                        setProcessingStep(`Transcribing Audio... ${percentage}%`); // Update the state
                    }
                } else {
                    console.log(`Transcription Server STDOUT: "${line}"`);
                }
            });

            command.stderr.on('data', (line) => {
                // Check if the message is an informational message
                if (line == "" || line.length < 1) {
                    return;
                }
                else if (line.includes('Adjustment:') || line.includes('Aligning:')) {
                    setProcessingStep(`Adjusting Timing...`); // Update the state
                }
                else if ((line.includes('address already in use') || line.includes('Uvicorn running') || line.includes('one usage of each socket')) && serverLoading.current) {
                    setProcessingStep("");
                    setIsLoading(false);
                    serverLoading.current = false;
                } 
                else if (line.includes('INFO:') || line.includes('VAD') || line.includes('Adjustment')) {
                    if (line.includes('speechbrain')) {
                        setProcessingStep("Diarizing speakers...");
                        setIsLoading(true);
                    } else {
                        console.log(`Transcription Server INFO: "${line}"`);
                    }
                } else if (line.includes("model.bin:")) {
                    const percentageMatch = line.match(/(\d+)%/);
                    if (percentageMatch && percentageMatch[1]) {
                        const percentage = parseInt(percentageMatch[1], 10);
                        setProcessingStep(`Downloading Model... ${percentage}%`); // Update the state
                    }
                } else if (line.includes("download")) {
                    setProcessingStep("Downloading Model..."); // Update the state
                } else {
                    console.error(`Transcription Server STDERR: "${line}"`);
                } 
            });

            console.log('Starting transcription server...');
            // Assign the spawned process to the global variable
            transcriptionProcess = await command.spawn();
            console.log('Transcription server started with PID:', transcriptionProcess.pid);
        } catch (error) {
            console.error("Failed to start the transcription server:", error);
        }
    }

    async function stopTranscriptionServer() {
        try {
            if (transcriptionProcess) {
                console.log('Stopping transcription server...');
                await transcriptionProcess.kill();
                console.log('Transcription server stopped');
            }
        }
        catch (error) {
            console.error("Failed to stop the transcription server:", error);
        }
    }

    async function fetchTranscription(audioPath: string) {
        setIsLoading(true);
        setSubtitles([]);
        try {
            let audioInfo = await exportAudio(audioPath);
            console.log("Fetching transcription...");
            setProcessingStep("Preparing to transcribe...");

            console.log("Audio Path: ", audioInfo.path);

            let body = {
                file_path: audioInfo.path,
                output_dir: storageDir,
                timeline: audioInfo.timeline,
                model: model,
                language: currentLanguage,
                task: translate ? "translate" : "transcribe",
                diarize: diarize,
                align_words: alignWords,
                max_words: maxWords,
                max_chars: maxChars,
                mark_in: audioInfo.markIn
            };

            console.log(body);

            // Make the POST request to the transcription API
            const response = await fetch(transcribeAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            // Check if the response is not successful
            if (!response.ok) {
                let errorMessage = `HTTP error! status: ${response.status}`;
                try {
                    // Attempt to parse the error message from the response
                    const errorData = await response.json();
                    if (errorData.detail) {
                        errorMessage = errorData.detail;
                    }
                } catch (jsonError) {
                    // If parsing fails, retain the default error message
                    console.error("Failed to parse error response as JSON:", jsonError);
                }
                // Set the error state with the extracted or default message
                setError({
                    title: "Transcription Error",
                    desc: errorMessage
                });
                // Throw an error to be caught in the catch block
                throw new Error(errorMessage);
            }

            // If the response is successful, parse the JSON data
            const data = await response.json();
            const filePath = data.result_file;

            // Proceed with processing the transcription result
            setProcessingStep("Populating timeline...");
            setSubtitles([]);
            await populateSubtitles(timeline);
            await addSubtitles(filePath);

        } catch (error: unknown) { // Explicitly type 'error' as 'unknown'
            // Handle any errors that occurred during the fetch or processing
            console.error("Error fetching transcription:", error);

            let errorMessage: string;
            // Type guard: Check if 'error' is an instance of Error
            if (error instanceof Error) {
                errorMessage = error.message;
            } else {
                errorMessage = String(error);
            }

            // Update the error state with the appropriate message
            setError({
                title: "Transcription Error",
                desc: errorMessage
            });

        } finally {
            // Ensure that the loading state is reset regardless of success or failure
            console.log("Finished transcribing.");
            setIsLoading(false);
        }
    }

    async function exportAudio(prevAudioPath: string) {
        if (prevAudioPath !== "") {
            return {
                path: audioPath,
                timeline: timeline,
                markIn: markIn
            };
        }
        // send request to Lua server (Resolve)
        setProcessingStep("Exporting Audio...");
        const response = await fetch(resolveAPI, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                func: "ExportAudio",
                outputDir: storageDir
            }),
        });

        const data = await response.json();

        if (data.timeline == "") {
            throw new Error("You need to open a timeline in Resolve to start transcribing.");
        }

        setTimeline(data.timeline);
        setAudioPath(data.path);
        setMarkIn(data.markIn);
        return data;
    };

    async function addSubtitles(filePath?: string) {
        if (!filePath) {
            await updateTranscript(speakers);
            filePath = await getFullTranscriptPath();
        }
        let sensitiveWordsList: string[] = [];
        if (sensitiveWords !== "") {
            sensitiveWordsList = sensitiveWords.split(',').map((word: string) => word.trim().toLowerCase());
        }
        try {
            const response = await fetch(resolveAPI, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    func: "AddSubtitles",
                    filePath,
                    templateName: currentTemplate,
                    trackIndex: currentTrack,
                    removePunctuation,
                    textFormat,
                    sensitiveWords: sensitiveWordsList,
                }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            console.log(data);
        } catch (error) {
            console.error('Error adding subtitles:', error);
            //setError("Error adding subtitles - Open the console in Resolve to see the error message (Workspace -> Console).");
            setError({
                title: "Error Adding Subtitles",
                desc: "Open the console in Resolve to see the error message (Workspace -> Console)."
            });
        }
    }

    async function getTimelineInfo() {
        try {
            const response = await fetch(resolveAPI, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ func: "GetTimelineInfo" }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            if (data.timelineId == "") {
                setError({
                    title: "No Timeline Detected",
                    desc: "You need to open a timeline in Resolve to start transcribing."
                });
                return;
            }
            let timelineId = data.timelineId;
            setTimeline(data.timelineId);
            return timelineId;
        } catch (error) {
            console.error('Error fetching timeline info (failed to connect to AutoSubs Link in Resolve):', error);
            setError({
                title: "Failed to connect to Resolve",
                desc: "Make sure to open AutoSubs via the Workspace -> Scripts menu inside Resolve."
            });
        }
    }

    async function jumpToTime(start: number) {
        try {
            const response = await fetch(resolveAPI, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ func: "JumpToTime", start, markIn }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            console.log(data);
        } catch (error) {
            console.error('Error jumping to time:', error);
            //setError("Failed to connect to Resolve. Open AutoSubs via the Workspace -> Scripts menu inside Resolve.")
            setError({
                title: "Failed to connect to Resolve",
                desc: "Make sure to open AutoSubs via the Workspace -> Scripts menu inside Resolve."
            });
        }
    }

    async function getTracks() {
        try {
            const response = await fetch(resolveAPI, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ func: "GetTracks" }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            console.log(data);
            setTrackList(data);
            console.log(data);
        } catch (error) {
            console.error('Error fetching tracks:', error);
            setError({
                title: "Failed to connect to Resolve",
                desc: "Make sure to open AutoSubs via the Workspace -> Scripts menu inside Resolve."
            });
        }
    }

    async function getTemplates() {
        try {
            const response = await fetch(resolveAPI, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ func: "GetTemplates" }),
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const data = await response.json();
            setTemplateList(data);
            console.log(data);
        } catch (error) {
            console.error('Error fetching templates:', error);
            setError({
                title: "Failed to connect to Resolve",
                desc: "Make sure to open AutoSubs via the Workspace -> Scripts menu inside Resolve."
            });
        }
    }

    async function readTranscript(timelineId: string) {
        if (timelineId == "") {
            timelineId = await getTimelineInfo();
            if (timelineId == "" || timelineId == undefined) return
        }

        const filePath = await join(storageDir, `${timelineId}.json`);

        try {
            // Check if the file exists
            const fileExists = await exists(filePath, { baseDir: BaseDirectory.Document });

            if (!fileExists) {
                console.log("Transcript file does not exist for this timeline.");
                return;
            }

            // Read JSON file
            console.log("Reading json file...");
            const contents = await readTextFile(filePath, { baseDir: BaseDirectory.Document });
            let transcript = JSON.parse(contents);
            return transcript;
        } catch (error) {
            setError({
                title: "Error reading transcript",
                desc: "Failed to read the transcript file. Please try again."
            })
        }
    }

    async function populateSubtitles(timelineId: string) {
        let transcript = await readTranscript(timelineId);
        if (transcript) {
            setMarkIn(transcript.mark_in)
            setSubtitles(transcript.segments);
            setSpeakers(transcript.speakers);
            setTopSpeaker(transcript.top_speaker);
        }
    }

    /**
    * Converts seconds to SRT timecode format (HH:mm:ss,SSS).
    * @param seconds Time in seconds to be converted.
    * @returns A formatted timecode string.
    */
    function formatTimecode(seconds: number): string {
        const ms = Math.floor((seconds % 1) * 1000);
        const totalSeconds = Math.floor(seconds);
        const s = totalSeconds % 60;
        const m = Math.floor((totalSeconds / 60) % 60);
        const h = Math.floor(totalSeconds / 3600);

        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    }

    /**
     * Converts an array of subtitles into an SRT-formatted string.
     * @returns A string formatted as an SRT file.
     */
    function generateSrt(): string {
        return subtitles.map((subtitle, index) => {
            // Format each subtitle into the SRT format
            return [
                (index + 1).toString(), // Subtitle index
                `${formatTimecode(Number(subtitle.start))} --> ${formatTimecode(Number(subtitle.end))}`, // Time range
                subtitle.text.trim(),
                "" // Empty line after each block
            ].join("\n");
        }).join("\n");
    }

    async function exportSubtitles() {
        try {
            const filePath = await save({
                defaultPath: 'subtitles.srt',
                filters: [{ name: 'SRT Files', extensions: ['srt'] }],
            });

            if (!filePath) {
                console.log('Save was canceled');
                return;
            }

            let srtData = generateSrt()
            await writeTextFile(filePath, srtData);
            console.log('File saved to', filePath);
        } catch (error) {
            console.error('Failed to save file', error);
        }
    }

    async function updateTranscript(speakers?: Speaker[], topSpeaker?: TopSpeaker, subtitles?: Subtitle[]) {
        if (!speakers && !subtitles) {
            return;
        }
        // read current file
        let transcript = await readTranscript(timeline);
        if (topSpeaker) {
            transcript.top_speaker = topSpeaker;
        }
        if (speakers) {
            transcript.speakers = speakers;
        }
        if (subtitles) {
            transcript.segments = subtitles;
        }

        // write to file
        const filePath = await join(storageDir, `${timeline}.json`);
        return await writeTextFile(filePath, JSON.stringify(transcript, null, 2), {
            baseDir: BaseDirectory.Document,
        });
    }

    async function updateSpeaker(index: number, label: string, color: string, style: string) {
        let newTopSpeaker = topSpeaker;
        if (topSpeaker.id === speakers[index].id) {
            newTopSpeaker = { ...topSpeaker, label };
            setTopSpeaker(newTopSpeaker); // Update the state
        }

        const newSpeakers = [...speakers];
        newSpeakers[index].label = label;
        newSpeakers[index].color = color;
        newSpeakers[index].style = style;

        setSpeakers(newSpeakers);
        await updateTranscript(newSpeakers, newTopSpeaker); // Use updated newTopSpeaker
    }


    async function initialize() {
        await populateSubtitles("");
        await getTracks();
        await getTemplates();
    }

    const hasInitialized = useRef(false);

    useEffect(() => {
        setTranscriptsFolder();

        // Prevents the effect from running again on subsequent renders
        if (!hasInitialized.current) {
            startTranscriptionServer();
            hasInitialized.current = true;
        }

        initializeStore();

        initialize();

        getCurrentWindow().once("tauri://close-requested", async () => {
            try {
                console.log("Stopping transcription server...");
                await stopTranscriptionServer();
            } catch (error) {
                console.warn("Failed to stop transcription server:", error);
            }

            console.log("Exiting...");

            try {
                await fetch(resolveAPI, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ func: "Exit" }),
                });
            } catch {
                // Swallow errors silently, as requested
            }

            exit(0);
        });
    }, []);

    return (
        <GlobalContext.Provider
            value={{
                timeline,
                trackList,
                templateList,
                subtitles,
                speakers,
                topSpeaker,
                currentTrack,
                currentTemplate,
                currentLanguage,
                model,
                translate,
                diarize,
                maxWords,
                maxChars,
                textFormat,
                removePunctuation,
                processingStep,
                sensitiveWords,
                alignWords,
                isLoading,
                error,
                audioPath,
                setError,
                setIsLoading,
                setModel,
                setTranslate,
                setDiarize,
                setMaxWords,
                setMaxChars,
                setTextFormat,
                setRemovePunctuation,
                setSensitiveWords,
                setAlignWords,
                setTemplate,
                setLanguage,
                setTrack,
                initialize,
                fetchTranscription,
                setSpeakers,
                updateSpeaker,
                getTimelineInfo,
                getTracks,
                getTemplates,
                populateSubtitles,
                addSubtitles,
                exportSubtitles,
                jumpToTime
            }}
        >
            {children}
        </GlobalContext.Provider>
    );
}

export const useGlobal = () => {
    const context = useContext(GlobalContext);
    if (context === undefined) {
        throw new Error('useGlobal must be used within a GlobalProvider');
    }
    return context;
};