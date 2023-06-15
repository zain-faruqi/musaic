require('dotenv').config('./.env')
const express = require('express')
const session = require('express-session')
const mongoose = require('mongoose')
const MongoSessionStore = require('connect-mongodb-session')(session);
const app = express()
const path = require("path");
const SpotifyWebApi = require('spotify-web-api-node');
const cors = require('cors');

mongoose
  .connect(`${process.env.DB_CONNECTION_STRING}`)
  .then(data => console.log(`Connected to MongoDB`))
  .catch(err => console.error(`Failed to connect to MongoDB: ${err}`));

var store = new MongoSessionStore ({
  uri: process.env.DB_CONNECTION_STRING,
  collection: 'express-sessions'
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: {
    	maxAge: 1000 * 60 * 60 // 1 hour
    },
    store: store
}))


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: 'http://localhost:3000', credentials: true }));

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri: process.env.ROOT_URL + '/callback'
});

const scopes = [
    'user-read-private',
    'user-read-email',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'streaming',
    'app-remote-control',
    'user-read-recently-played',
    'user-top-read',
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-public',
    'playlist-modify-private',
    'user-library-read',
    'user-library-modify',
    'user-follow-read',
    'user-follow-modify'
];

const spotifyRoutes = require('./routes/spotifyCalls')(spotifyApi);
app.use('/spotify', spotifyRoutes);


app.get('/', (req, res) => {
    if (req.session.user) {
        const refresh_token = req.session.user.refresh_token;
        spotifyApi.setRefreshToken(refresh_token);

        spotifyApi
            .refreshAccessToken()
            .then(data => {
                req.session.user.access_token = data.body['access_token'];
                req.session.save(err => {
                    if (err) {
                        console.error(err);
                    } else {
                        console.log(req.session.user);
                    }
                })   
            })
            .catch(err => {
                console.log('Could not refresh access token', err);
            });
        // redirect to home only if the user has logged in
        res.redirect('http://localhost:3000/home');
    } else {
        res.redirect('http://localhost:3000/login'); // if not, redirect to login page
    }
});

app.get('/auth', (req, res) => {
    res.redirect(spotifyApi.createAuthorizeURL(scopes));
});

app.get('/callback', (req, res) => {
    const error = req.query.error;
    const code = req.query.code;
    const state = req.query.state;

    if (error) {
        console.log('Callback Error:', error);
        res.redirect('http://localhost:3000/login');
        return;
    }

    spotifyApi
        .authorizationCodeGrant(code)
        .then(data => {
            const access_token = data.body['access_token'];
            const refresh_token = data.body['refresh_token'];
            const expires_in = data.body['expires_in'];

            spotifyApi.setAccessToken(access_token);
            spotifyApi.setRefreshToken(refresh_token);

            req.session.user = {
                access_token: access_token,
                refresh_token: refresh_token
            };
            
    	   req.session.save(err => {
            if (err) {
                console.error(err);
            } else {
                console.log(req.session.user);
                res.redirect("http://localhost:3000/home");
            }
        });
        })
});

app.get('/refresh_token', (req, res) => {
    const refresh_token = req.session.user.refresh_token;
    spotifyApi.setRefreshToken(refresh_token);

    spotifyApi
        .refreshAccessToken()
        .then(data => {
            res.send({
                'access_token': data.body['access_token'],
                'expires_in': data.body['expires_in']
            });
        })
        .catch(err => {
            console.log('Could not refresh access token', err);
        });
});


if (process.env.NODE_ENV == 'production') {
    console.log(__dirname);
    app.use(express.static(path.join(__dirname, '../front-end/build')));
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../front-end', 'build', 'index.html'));
    });
} else {
    app.get('/', (req, res) => {
        res.send(process.env.NODE_ENV);
    });
}
  
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

module.exports = app;
