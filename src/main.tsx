import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.tsx';
import Viewer from './Viewer.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/view" element={<Viewer />} />
        <Route path="/view/:fileId" element={<Viewer />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
