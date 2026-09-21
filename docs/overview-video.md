# Collaborative AI-DLC in action

See how a team turns an intent into code while humans and remote coding agents share one structured workflow.

<div style="max-width: 960px; margin: 1.5rem auto; border-radius: 14px; overflow: hidden; background: #0f172a; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.22);">
  <video controls playsinline preload="none" poster="../assets/readme/collaborative-ai-dlc-overview-poster.png" style="display: block; width: 100%; height: auto;">
    <source src="https://github.com/aws-samples/sample-collaborative-ai-dlc/releases/download/readme-video-v1/collaborative-ai-dlc-overview.mp4" type="video/mp4" />
    Your browser cannot play this video. <a href="https://github.com/aws-samples/sample-collaborative-ai-dlc/releases/download/readme-video-v1/collaborative-ai-dlc-overview.mp4">Download the MP4 instead.</a>
  </video>
</div>

<p style="text-align: center; color: #64748b; font-size: 0.9rem;">
  A five-minute overview of shared intent, human gates, parallel execution, pull requests, and traceability.
  <br />
  <span id="overview-video-play-count" aria-live="polite" title="Approximate count based on video loads." hidden style="align-items: center; gap: 0.35rem; margin-top: 0.6rem; color: var(--md-default-fg-color--light); font-size: 0.82rem; font-weight: 500; font-variant-numeric: tabular-nums;">
    <span aria-hidden="true" style="color: var(--md-primary-fg-color); font-size: 0.7rem; line-height: 1;">▶</span>
    <span><span id="overview-video-play-count-value"></span> plays</span>
  </span>
</p>

<script>
  (() => {
    const counter = document.getElementById("overview-video-play-count");
    const value = document.getElementById("overview-video-play-count-value");
    const assetName = "collaborative-ai-dlc-overview.mp4";

    const formatCount = (count) =>
      new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      })
        .format(count)
        .toLowerCase();

    fetch("https://api.github.com/repos/aws-samples/sample-collaborative-ai-dlc/releases/tags/readme-video-v1", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
        return response.json();
      })
      .then((release) => release.assets.find((asset) => asset.name === assetName))
      .then((asset) => {
        if (!asset) throw new Error("Video asset not found");
        const formattedCount = formatCount(asset.download_count);
        value.textContent = formattedCount;
        counter.setAttribute("aria-label", `${formattedCount} approximate video plays`);
        counter.hidden = false;
        counter.style.display = "inline-flex";
      })
      .catch(() => {
        counter.hidden = true;
        counter.style.display = "none";
      });
  })();
</script>

## What you will see

- An intent moving from its initial prompt to a generated pull request.
- Humans collaborating with remote coding agents in one shared workflow.
- The traceability graph connecting the intent, its artifacts, and delivered code.

## Music credit

“Inspired” by Kevin MacLeod ([incompetech.com](https://incompetech.com/))<br />
Licensed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
