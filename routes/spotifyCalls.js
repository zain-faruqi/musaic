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

  return router;
};

