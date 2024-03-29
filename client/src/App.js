import React, { useState } from 'react'
import { BrowserRouter as Router, Routes, Route, useLocation } from 'react-router-dom'
import Login from './pages/Login'
import Player from './pages/Player'
import Home from './pages/Home'
import NavBar from './components/Nav'
import PersistantPlayer from './components/Persistant-Player'
import './styles.css'


const Layout = ({ children, playUri }) => {

  const location = useLocation();
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "97vh", width: "99vw" }}>
      {location.pathname !== '/login' && <NavBar />}
    <div className= "children" style={{ flex: 1}}>{children}</div>
      {(location.pathname !== '/login') && <PersistantPlayer style={{width: "99vw"} } playUri={playUri}/>}
    </div>
  );
}


function App() {
  const [playUri, setPlayUri] = useState(null);
  return (
    <Router>
      <Layout playUri={playUri}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/home" element={<Home setPlayUri={setPlayUri} />} />
        </Routes>
      </Layout>
    </Router>
  );
}


export default App;
