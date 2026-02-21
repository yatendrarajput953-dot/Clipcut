/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, Link, Loader2, Play, Pause, Scissors, Download, AlertCircle, CheckCircle2, Volume2, VolumeX, Maximize, Share2 } from 'lucide-react';

// Types
interface Clip {
  title: string;
  description: string;
  startTime: string; // MM:SS
  endTime: string; // MM:SS
  viralityScore: number;
}

interface AnalysisResult {
  clips: Clip[];
}

export default function App() {
  const [step, setStep] = useState<'upload' | 'processing' | 'results'>('upload');
  const [videoSource, setVideoSource] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [localFilename, setLocalFilename] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loadingText, setLoadingText] = useState('Uploading video...');
  const [error, setError] = useState<string | null>(null);
  const [activeClip, setActiveClip] = useState<Clip | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0); // 0: Upload, 1: Process, 2: Analyze
  
  // Preferences
  const [targetDuration, setTargetDuration] = useState<string>('auto');
  const [summaryStyle, setSummaryStyle] = useState<string>('balanced');

  // Helper to poll file status
  const waitForFileActive = async (fileId: string) => {
    setLoadingStep(1);
    setLoadingText('Processing video for AI analysis...');
    
    let attempts = 0;
    while (attempts < 60) { // Timeout after ~2 minutes
      try {
        const res = await fetch(`/api/file-status?fileId=${fileId}`);
        if (!res.ok) throw new Error('Failed to check status');
        const data = await res.json();
        
        if (data.state === 'ACTIVE') {
          return true;
        } else if (data.state === 'FAILED') {
          throw new Error('Video processing failed');
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
      } catch (err) {
        console.error('Polling error:', err);
        throw err;
      }
    }
    throw new Error('Processing timeout');
  };

  // Upload handlers
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Create local preview URL
    const url = URL.createObjectURL(file);
    setVideoSource(url);
    setStep('processing');
    setLoadingStep(0);
    setLoadingText('Uploading video to server...');
    setError(null);

    const formData = new FormData();
    formData.append('video', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      
      if (!res.ok) throw new Error('Upload failed');
      
      const data = await res.json();
      setFileId(data.fileId);
      setLocalFilename(data.localFilename);
      
      await waitForFileActive(data.fileId);
      analyzeVideo(data.fileId);
    } catch (err: any) {
      setError(err.message);
      setStep('upload');
    }
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const urlInput = form.elements.namedItem('url') as HTMLInputElement;
    const url = urlInput.value;

    if (!url) return;

    setVideoSource(url);
    setStep('processing');
    setLoadingStep(0);
    setLoadingText('Downloading video from URL...');
    setError(null);

    try {
      const res = await fetch('/api/process-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to process URL');
      }

      const data = await res.json();
      setFileId(data.fileId);
      setLocalFilename(data.localFilename);
      
      await waitForFileActive(data.fileId);
      analyzeVideo(data.fileId);
    } catch (err: any) {
      setError(err.message);
      setStep('upload');
    }
  };

  const handleDownloadClip = async (clip: Clip) => {
    if (!localFilename) return;
    
    setIsDownloading(true);
    try {
      const params = new URLSearchParams({
        filename: localFilename,
        startTime: clip.startTime,
        endTime: clip.endTime
      });
      
      const response = await fetch(`/api/download-clip?${params.toString()}`);
      if (!response.ok) throw new Error('Download failed');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${clip.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.mp4`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error('Download error:', err);
      alert('Failed to download clip. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  };

  const analyzeVideo = async (id: string) => {
    setLoadingStep(2);
    setLoadingText('Analyzing content with AI (this may take a moment)...');
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fileId: id,
          preferences: {
            duration: targetDuration,
            style: summaryStyle
          }
        }),
      });

      if (!res.ok) throw new Error('Analysis failed');

      const data = await res.json();
      // Parse the response text if it's a string (Gemini sometimes returns markdown code blocks)
      let result = data;
      if (typeof data === 'string') {
          try {
            // Remove markdown code blocks if present
            const cleanJson = data.replace(/```json\n|\n```/g, '');
            result = JSON.parse(cleanJson);
          } catch (e) {
             console.error("Failed to parse JSON", e);
          }
      }
      
      // If the API returns the object directly (which our server does via JSON.parse), use it.
      // Our server code: res.json(JSON.parse(responseText));
      // So 'data' should be the object.
      
      setAnalysis(result);
      setStep('results');
      if (result.clips?.length > 0) {
        setActiveClip(result.clips[0]);
      }
    } catch (err: any) {
      setError(err.message);
      setStep('upload');
    }
  };

  const handleShareClip = async (clip: Clip) => {
    if (!localFilename) return;
    
    setIsSharing(true);
    try {
      const params = new URLSearchParams({
        filename: localFilename,
        startTime: clip.startTime,
        endTime: clip.endTime
      });
      
      const response = await fetch(`/api/download-clip?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch clip for sharing');
      
      const blob = await response.blob();
      const file = new File([blob], `${clip.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.mp4`, { type: 'video/mp4' });

      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: clip.title,
          text: clip.description,
        });
      } else {
        // Fallback: Copy title and description to clipboard
        await navigator.clipboard.writeText(`${clip.title}\n${clip.description}`);
        alert('Sharing not supported on this device. Clip details copied to clipboard.');
      }
    } catch (err) {
      console.error('Share error:', err);
      alert('Failed to share clip. Please try again.');
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-indigo-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <Scissors className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight">ClipStream AI</span>
          </div>
          <div className="text-sm text-white/50">
            Powered by Gemini 2.5
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-12">
        <AnimatePresence mode="wait">
          {step === 'upload' && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="max-w-2xl mx-auto"
            >
              <div className="text-center mb-12">
                <h1 className="text-4xl md:text-5xl font-bold mb-4 bg-gradient-to-r from-white to-white/50 bg-clip-text text-transparent">
                  Turn long videos into viral clips.
                </h1>
                <p className="text-lg text-white/60">
                  Upload a video or paste a URL. AI will identify the most engaging moments for you.
                </p>
              </div>

              {error && (
                <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center gap-3 text-red-400">
                  <AlertCircle className="w-5 h-5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="grid gap-6">
                
                {/* Preferences Section */}
                <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
                  <h3 className="text-sm font-semibold text-white/70 uppercase tracking-wider">Analysis Preferences</h3>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-white/50 mb-2">Target Clip Duration</label>
                      <select 
                        value={targetDuration}
                        onChange={(e) => setTargetDuration(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
                      >
                        <option value="auto">Auto (AI Decides)</option>
                        <option value="15">Short (~15s)</option>
                        <option value="30">Medium (~30s)</option>
                        <option value="60">Long (~60s)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-white/50 mb-2">Focus Style</label>
                      <select 
                        value={summaryStyle}
                        onChange={(e) => setSummaryStyle(e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-indigo-500/50"
                      >
                        <option value="balanced">Balanced (Mix)</option>
                        <option value="spoken">Spoken Words / Dialogue</option>
                        <option value="visual">Visual Highlights / Action</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* File Upload */}
                <div className="relative group">
                  <input
                    type="file"
                    accept="video/*"
                    onChange={handleFileUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  />
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-12 text-center transition-all group-hover:bg-white/10 group-hover:border-indigo-500/50 group-hover:shadow-lg group-hover:shadow-indigo-500/10">
                    <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                      <Upload className="w-8 h-8 text-white/70" />
                    </div>
                    <h3 className="text-xl font-semibold mb-2">Upload Video File</h3>
                    <p className="text-white/40 text-sm">Drag & drop or click to browse (MP4, MOV, WebM)</p>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-white/20">
                  <div className="h-px bg-white/10 flex-1" />
                  <span>OR</span>
                  <div className="h-px bg-white/10 flex-1" />
                </div>

                {/* URL Input */}
                <form onSubmit={handleUrlSubmit} className="relative">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <Link className="w-5 h-5 text-white/40" />
                  </div>
                  <input
                    type="url"
                    name="url"
                    placeholder="Paste a direct video URL (e.g., https://example.com/video.mp4)"
                    className="w-full bg-white/5 border border-white/10 rounded-xl py-4 pl-12 pr-32 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
                  />
                  <button
                    type="submit"
                    className="absolute right-2 top-2 bottom-2 bg-white text-black font-medium px-6 rounded-lg hover:bg-white/90 transition-colors"
                  >
                    Process
                  </button>
                </form>
                <p className="text-xs text-center text-white/30">
                  Note: YouTube URLs are not supported in this demo due to platform restrictions. Please use direct video links.
                </p>
              </div>
            </motion.div>
          )}

          {step === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center min-h-[60vh]"
            >
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-indigo-500/20 blur-3xl rounded-full" />
                <Loader2 className="w-16 h-16 text-indigo-500 animate-spin relative z-10" />
              </div>
              
              <h2 className="text-2xl font-semibold mb-2">{loadingText}</h2>
              <p className="text-white/40 mb-8">This might take a minute for larger videos.</p>

              {/* Progress Steps */}
              <div className="w-full max-w-md space-y-4">
                {[
                  { label: 'Upload / Download', step: 0 },
                  { label: 'Processing Video', step: 1 },
                  { label: 'AI Analysis', step: 2 },
                ].map((item) => (
                  <div key={item.step} className="flex items-center gap-4">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center border transition-colors ${
                      loadingStep > item.step 
                        ? 'bg-green-500 border-green-500 text-black'
                        : loadingStep === item.step
                        ? 'bg-indigo-500 border-indigo-500 text-white animate-pulse'
                        : 'bg-transparent border-white/20 text-white/20'
                    }`}>
                      {loadingStep > item.step ? (
                        <CheckCircle2 className="w-5 h-5" />
                      ) : (
                        <span className="text-sm font-bold">{item.step + 1}</span>
                      )}
                    </div>
                    <span className={`font-medium ${
                      loadingStep >= item.step ? 'text-white' : 'text-white/20'
                    }`}>
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}

          {step === 'results' && analysis && (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid lg:grid-cols-3 gap-8"
            >
              {/* Main Player Area */}
              <div className="lg:col-span-2 space-y-6">
                <div className="bg-black rounded-2xl overflow-hidden border border-white/10 aspect-video relative group">
                  {videoSource && activeClip && (
                    <ClipPlayer
                      src={videoSource}
                      startTime={activeClip.startTime}
                      endTime={activeClip.endTime}
                    />
                  )}
                </div>
                
                {activeClip && (
                  <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h2 className="text-2xl font-bold mb-2">{activeClip.title}</h2>
                        <p className="text-white/60 leading-relaxed">{activeClip.description}</p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="bg-indigo-500/20 text-indigo-300 px-3 py-1 rounded-full text-sm font-medium border border-indigo-500/30">
                          Viral Score: {activeClip.viralityScore}/10
                        </div>
                        <div className="text-xs text-white/40 font-mono">
                          {activeClip.startTime} - {activeClip.endTime}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Clips List */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-white/80 px-2">Generated Clips</h3>
                <div className="space-y-3">
                  {analysis.clips.map((clip, idx) => (
                    <button
                      key={idx}
                      onClick={() => setActiveClip(clip)}
                      className={`w-full text-left p-4 rounded-xl border transition-all ${
                        activeClip === clip
                          ? 'bg-indigo-600/20 border-indigo-500/50 shadow-lg shadow-indigo-500/10'
                          : 'bg-white/5 border-white/10 hover:bg-white/10'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <h4 className={`font-medium ${activeClip === clip ? 'text-indigo-300' : 'text-white'}`}>
                          {clip.title}
                        </h4>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono text-white/40 bg-black/20 px-2 py-1 rounded">
                            {clip.startTime}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadClip(clip);
                            }}
                            disabled={isDownloading}
                            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors disabled:opacity-50"
                            title="Download Clip"
                          >
                            {isDownloading ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Download className="w-3 h-3" />
                            )}
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleShareClip(clip);
                            }}
                            disabled={isSharing}
                            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-colors disabled:opacity-50"
                            title="Share Clip"
                          >
                            {isSharing ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Share2 className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </div>
                      <p className="text-sm text-white/50 line-clamp-2">{clip.description}</p>
                    </button>
                  ))}
                </div>
                
                <button
                  onClick={() => {
                    setStep('upload');
                    setVideoSource(null);
                    setAnalysis(null);
                  }}
                  className="w-full mt-8 py-3 rounded-xl border border-white/10 text-white/60 hover:bg-white/5 transition-colors text-sm"
                >
                  Process Another Video
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

// Helper component for video playback
function ClipPlayer({ src, startTime, endTime }: { src: string; startTime: string; endTime: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  
  // Convert MM:SS to seconds
  const parseTime = (time: string) => {
    const [min, sec] = time.split(':').map(Number);
    return min * 60 + sec;
  };

  const startSeconds = parseTime(startTime);
  const endSeconds = parseTime(endTime);
  const duration = endSeconds - startSeconds;

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.currentTime = startSeconds;
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
      setProgress(0);
    }
  }, [src, startTime, startSeconds]);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const current = videoRef.current.currentTime;
      
      // Loop if end reached
      if (current >= endSeconds) {
        videoRef.current.currentTime = startSeconds;
        videoRef.current.play().catch(() => {});
        setProgress(0);
      } else {
        // Calculate progress percentage relative to clip duration
        const relativeTime = Math.max(0, current - startSeconds);
        const percent = (relativeTime / duration) * 100;
        setProgress(Math.min(100, percent));
      }
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newProgress = parseFloat(e.target.value);
    setProgress(newProgress);
    
    if (videoRef.current) {
      const newTime = startSeconds + (duration * (newProgress / 100));
      videoRef.current.currentTime = newTime;
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setIsMuted(newVolume === 0);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      const newMuted = !isMuted;
      setIsMuted(newMuted);
      videoRef.current.muted = newMuted;
      if (!newMuted && volume === 0) {
        setVolume(0.5);
        videoRef.current.volume = 0.5;
      }
    }
  };

  const containerRef = useRef<HTMLDivElement>(null);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black group">
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-contain"
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />
      
      {/* Play/Pause Overlay */}
      <div 
        className="absolute inset-0 flex items-center justify-center bg-black/20 transition-opacity duration-300 opacity-0 hover:opacity-100 pointer-events-none"
      >
        <button
          onClick={togglePlay}
          className="w-16 h-16 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center hover:scale-110 transition-transform pointer-events-auto"
        >
          {isPlaying ? (
            <Pause className="w-8 h-8 text-white fill-current" />
          ) : (
            <Play className="w-8 h-8 text-white fill-current ml-1" />
          )}
        </button>
      </div>
      
      {/* Bottom Controls Bar */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-6 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
        <div className="flex flex-col gap-3">
          {/* Progress Bar */}
          <div className="relative w-full h-1.5 bg-white/20 rounded-full cursor-pointer group/progress hover:h-2 transition-all">
            <div 
              className="absolute top-0 left-0 h-full bg-indigo-500 rounded-full" 
              style={{ width: `${progress}%` }}
            />
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={progress}
              onChange={handleSeek}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={togglePlay} className="text-white hover:text-indigo-400 transition-colors">
                {isPlaying ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
              </button>
              
              <div className="flex items-center gap-2 group/volume">
                <button onClick={toggleMute} className="text-white hover:text-indigo-400 transition-colors">
                  {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
                </button>
                <div className="w-0 overflow-hidden group-hover/volume:w-24 transition-all duration-300 flex items-center">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={isMuted ? 0 : volume}
                    onChange={handleVolumeChange}
                    className="w-20 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                </div>
              </div>

              <div className="text-xs font-mono text-white/70">
                <span>{startTime}</span>
                <span className="mx-1">/</span>
                <span>{endTime}</span>
              </div>
            </div>

            <button 
              onClick={toggleFullscreen}
              className="text-white hover:text-indigo-400 transition-colors"
              title="Fullscreen"
            >
              <Maximize className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
