import React from 'react'
import Shelf from '../../components/Shelf'
import './styles.css'

export default function Home() {
  return (
    <div className="home-container">
      <h2>Welcome...</h2>
      <Shelf />
      <Shelf />
      <Shelf />
    </div>
  )
}
