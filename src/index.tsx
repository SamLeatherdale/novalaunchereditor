import "bootstrap/dist/css/bootstrap.min.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import React from "react";
import ReactDOM from "react-dom";
import App from "./App";
import "./styles/main.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
ReactDOM.render(<App />, root);
