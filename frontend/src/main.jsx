import React from "react"
import { createRoot } from "react-dom/client"
import PepeGuessrApp from "./pepeguessr-app.jsx"
import "./styles.css"

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PepeGuessrApp />
  </React.StrictMode>
)
