const express = require('express');
const router = express.Router();

module.exports = function (spotifyApi) {
    
    router.get('/userToken', (req, res) => {
    if (req.session.user) {
        spotifyApi.setAccessToken(req.session.user.access_token);
        res.json({ access_token: req.session.user.access_token });
    } else {
        res.json({ error: 'No user session available' });
    }
    });
    

    router.get('/defaultFavoritePlaylists', async (req, res) => {
        
        spotifyApi.setAccessToken(req.session.user.access_token);
        const userInfo = await spotifyApi.getMe();
        const apiLists = await spotifyApi.getUserPlaylists(userInfo.body.id);
        const playlists = apiLists.body.items;
        const playlistsArray = [];

        for (let i = 0; i < 4 && i < playlists.length; i++) {
            const playlist = playlists[i];
            playlistsArray.push({
                name: playlist.name,
                img: playlist.images[0].url,
                uri: playlist.uri,
                owner: playlist.owner.display_name
            });
        }
        res.json(playlistsArray);
    });

  return router;
};

