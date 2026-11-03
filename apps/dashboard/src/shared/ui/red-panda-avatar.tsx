import completed from "../../assets/avatars/red-panda/completed.png";
import thinking from "../../assets/avatars/red-panda/thinking.png";
import waiting from "../../assets/avatars/red-panda/waiting.png";
import "./red-panda-avatar.css";

export type RedPandaMood = "completed" | "thinking" | "waiting";
const portraits = { completed, thinking, waiting };

export function RedPandaAvatar({ mood, size = 32 }: { mood: RedPandaMood; size?: number }) {
  return <span className="red-panda-avatar-frame" aria-hidden="true" style={{ width: size, height: size }}>
    <img className="red-panda-avatar" src={portraits[mood]} width={size} height={size}
      data-mood={mood} alt="" draggable={false} />
  </span>;
}
