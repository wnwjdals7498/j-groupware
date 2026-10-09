import { createRoot } from "react-dom/client";
import "@j-groupware/ui/styles.css";
import "@j-messenger/client-react/styles.css";
import "./styles.css";
import { App } from "./app.js";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
createRoot(root).render(<App />);
