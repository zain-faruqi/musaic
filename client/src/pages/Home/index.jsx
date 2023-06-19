import React, { useEffect, useState } from 'react'
import Shelf from '../../components/Shelf'
import './styles.css'

export default function Home(props) {

  const [favorites, setFavorites] = useState([]);


  useEffect(() => {
    fetch('http://localhost:8080/spotify/defaultFavoritePlaylists', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data) {
          setFavorites(data)
        }
      }
    )
  }, [])

  const handleItemClick = (uri) => {
    console.log(uri)
    props.setPlayUri(uri);
  };

  return (
    <div className="home-container">
      <h2>Welcome...</h2>
      <Shelf items={favorites} onItemClick={handleItemClick} title={'Favorites'} />
      <Shelf items={favorites} onItemClick={handleItemClick} title={'Popular'}/>
      <Shelf items={favorites} onItemClick={handleItemClick} title={'From your friends'}/>
    </div>
  )
}
