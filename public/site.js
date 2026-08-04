document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".kg-audio-card").forEach((card) => {
    const audio = card.querySelector("audio");
    const play = card.querySelector(".kg-audio-play-icon");
    const pause = card.querySelector(".kg-audio-pause-icon");
    const seek = card.querySelector(".kg-audio-seek-slider");
    const volume = card.querySelector(".kg-audio-volume-slider");
    const current = card.querySelector(".kg-audio-current-time");
    const duration = card.querySelector(".kg-audio-duration");
    if (!audio) return;

    const formatTime = (seconds) => {
      if (!Number.isFinite(seconds)) return "0:00";
      const minutes = Math.floor(seconds / 60);
      return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    };
    const showPlaying = (playing) => {
      play?.classList.toggle("kg-audio-hide", playing);
      pause?.classList.toggle("kg-audio-hide", !playing);
    };
    const update = () => {
      if (seek && audio.duration) seek.value = String((audio.currentTime / audio.duration) * 100);
      if (current) current.textContent = formatTime(audio.currentTime);
      if (duration) duration.textContent = formatTime(audio.duration);
    };

    play?.addEventListener("click", () => audio.play());
    pause?.addEventListener("click", () => audio.pause());
    audio.addEventListener("play", () => showPlaying(true));
    audio.addEventListener("pause", () => showPlaying(false));
    audio.addEventListener("ended", () => showPlaying(false));
    audio.addEventListener("loadedmetadata", update);
    audio.addEventListener("timeupdate", update);
    seek?.addEventListener("input", () => {
      if (audio.duration) audio.currentTime = (Number(seek.value) / 100) * audio.duration;
    });
    volume?.addEventListener("input", () => {
      audio.volume = Number(volume.value) / Number(volume.max || 100);
    });
  });

  document.querySelectorAll(".gh-burger").forEach((button) => {
    button.addEventListener("click", () => {
      const header = button.closest("#gh-head");
      if (!header) return;
      const open = header.classList.toggle("is-head-open");
      button.setAttribute("aria-expanded", String(open));
    });
  });
});
