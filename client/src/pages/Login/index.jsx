import React from 'react'
import './styles.css'

export default function Login() {

    const SpotifyLogin = () => {
        window.open('http://localhost:8080/auth', '_self');
    }
    
    return (
        <div className='container'>
            <div className='square'>
                <div className='square'>
                      <div className='square'>
            <div className='square'>
                 <div className='square'>
        <div className='login-container'>
            <h1>musaic</h1>
            <div className="login-button" onClick={SpotifyLogin}>
                Login with Spotify
            </div>   
          </div>
            </div>
            </div>
                    </div>
                    </div>
            </div>
            </div>
       
        
     
  )
}
