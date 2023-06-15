import React from 'react'
import { useState, useEffect } from 'react'
import SpotifyPlayer from 'react-spotify-web-playback'
import './styles.css'

export default function PersistantPlayer() {

    const [token, setToken] = useState(false);
    const [playQueue, setPlayQueue] = useState(['spotify:playlist:2FpPZu6woUabeVYV5Gscmi']);

    useEffect(() => {
        fetch('http://localhost:8080/spotify/userToken', { credentials: 'include' })
            .then(response => response.json())
            .then(data => {
                setToken(data.access_token);
                console.log(data.access_token);
            })
            .catch(err => {
                console.log(err);
            });
    }, [])

    if (!token) {
        return <div>loading...</div>
    } else {
        return (
            <div className='player-container'>
                <SpotifyPlayer
                    token={token}
                    showSaveIcon
                    uris={playQueue}
                    styles={{
                        activeColor: '#fff',
                        bgColor: 'black',
                        color: '#fff',
                        loaderColor: '#fff',
                        sliderColor: '#1cb954',
                        trackArtistColor: '#ccc',
                        trackNameColor: '#fff',
                    }}
                />
            </div>
        )
    }
}
