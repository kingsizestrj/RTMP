// Quais vídeos PRECISAM do arquivo original preservado. Canais em modo
// 'copy'/'transcode' transmitem o arquivo original (uploads); só o modo
// 'normalized' usa o .ts. Logo, o original de um vídeo usado por algum canal
// copy/transcode (na playlist padrão, em blocos da grade, como vinheta ou como
// comercial direcionado a ele) não pode ser apagado.
const db = require('./db');

function videosNeedingOriginal() {
  const state = db.get();
  const need = new Set();
  const plById = new Map(state.playlists.map((p) => [p.id, p]));
  const addPlaylist = (plId) => {
    const pl = plById.get(plId);
    if (pl) for (const vid of pl.videoIds || []) need.add(vid);
  };
  for (const c of state.channels) {
    if (c.mode === 'normalized') continue;
    addPlaylist(c.defaultPlaylistId);
    for (const b of c.schedule || []) addPlaylist(b.playlistId);
    for (const vid of c.breakVideoIds || []) need.add(vid);
    for (const cam of state.campaigns || []) {
      if (!cam.channelIds || !cam.channelIds.length || cam.channelIds.includes(c.id)) need.add(cam.videoId);
    }
  }
  return need;
}

module.exports = { videosNeedingOriginal };
