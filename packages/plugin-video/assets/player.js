// Minimal HLS attach for the in-app <video data-hls> player. Uses native HLS on
// Safari/iOS; elsewhere lazy-loads the sibling hls.js (only when actually
// needed, so Safari never pays for it). Classic script (hls.js dist is UMD).
(function () {
  var self = document.currentScript;
  var hlsUrl = self && self.src ? self.src.replace(/player\.js(\?.*)?$/, 'hls.js') : 'hls.js';
  var loading = null;

  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = hlsUrl;
      s.onload = function () {
        resolve(window.Hls);
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return loading;
  }

  function attach(video) {
    var url = video.getAttribute('data-hls');
    if (!url || video.dataset.hlsInit) return;
    video.dataset.hlsInit = '1';

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url; // native HLS
      return;
    }
    loadHls()
      .then(function (Hls) {
        if (Hls && Hls.isSupported()) {
          var hls = new Hls();
          hls.loadSource(url);
          hls.attachMedia(video);
        } else {
          video.src = url; // last resort
        }
      })
      .catch(function () {
        video.src = url;
      });
  }

  function init() {
    var vids = document.querySelectorAll('video[data-hls]');
    for (var i = 0; i < vids.length; i++) attach(vids[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
