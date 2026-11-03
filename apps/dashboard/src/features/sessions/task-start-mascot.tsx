import peeking from "../../assets/avatars/red-panda/peeking-front-v2.png";
import "./task-start-mascot.css";

export function TaskStartMascot() {
  return <img className="task-start-mascot" src={peeking} width={112} height={112}
    alt="" aria-hidden="true" draggable={false} />;
}
