# robot_coze/dingding/card/runtime/card_builder.py
import uuid
from typing import Optional, Dict, Any
from shared.config import config
from shared.dingtalk.credentials import bot_name_from_data, robot_code_for_bot
from shared.logging import logger
from .payload_utils import convert_json_values_to_string
from .debug_state import is_card_debug_enabled
from ..general_card import build_general_card_params

class CardBuilder:
    """
    钉钉互动卡片 Payload 构建?
    负责组装符合钉钉协议?JSON 数据结构
    """

    @staticmethod
    def _is_likely_dingtalk_user_id(user_id: str) -> bool:
        """
        钉钉 userId/staffId 在本项目中常为纯数字字符串?
        非数字（?unionId/openId）不要写?privateData ?key?
        """
        return user_id.isdigit()

    @classmethod
    def _build_debug_private_data(cls, private_user_id: Optional[str]) -> Optional[Dict[str, Any]]:
        """全局调试开关注入钉钉卡片调试入口（无需在模板中显式声明）"""
        private_key = str(private_user_id or "").strip()
        if not private_key:
            return None
        if not cls._is_likely_dingtalk_user_id(private_key):
            logger.info(
                f"[CardDebug] skip inject: private user key is not numeric userId: {private_key}"
            )
            return None

        if not is_card_debug_enabled():
            return None

        payload = {
            private_key: {
                "cardParamMap": {
                    "_CARD_DEBUG_TOOL_ENTRY": "show"
                }
            }
        }
        return payload

    @classmethod
    def _build_delivery_payload(
        cls,
        *,
        raw_data: Dict[str, Any],
        out_track_id: str,
        card_template_id: str,
        card_data: Dict[str, Any],
    ) -> Dict[str, Any]:
        payload = {
            "callbackType": "STREAM",
            "cardTemplateId": card_template_id,
            "outTrackId": out_track_id,
            "cardData": {"cardParamMap": convert_json_values_to_string(card_data)},
        }

        cid = raw_data.get("conversationId")
        uid = raw_data.get("senderStaffId") or raw_data.get("senderId")
        conversation_type = raw_data.get("conversationType")

        if conversation_type == "2":
            robot_code = str(raw_data.get("robotCode") or "").strip() or robot_code_for_bot(
                bot_name_from_data(raw_data)
            )
            payload.update({
                "openSpaceId": f"dtv1.card//IM_GROUP.{cid}",
                "imGroupOpenSpaceModel": {"supportForward": True},
                "imGroupOpenDeliverModel": {"robotCode": robot_code},
            })
        else:
            payload.update({
                "openSpaceId": f"dtv1.card//IM_ROBOT.{uid}",
                "imRobotOpenSpaceModel": {"supportForward": True},
                "imRobotOpenDeliverModel": {"spaceType": "IM_ROBOT"},
            })

        debug_private_data = cls._build_debug_private_data(
            private_user_id=raw_data.get("senderStaffId") or raw_data.get("userId"),
        )
        if debug_private_data:
            payload["privateData"] = debug_private_data
            logger.info(
                f"[CardDebug] send inject privateData users={list(debug_private_data.keys())}"
            )

        return payload

    @classmethod
    def create_general_card_send_payload(
        cls,
        *,
        raw_data: Dict[str, Any],
        card_params: Dict[str, Any],
        out_track_id: Optional[str] = None,
        card_template_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        final_track_id = out_track_id or str(uuid.uuid4())
        final_template_id = card_template_id or config.GENERAL_CARD_TEMPLATE_ID
        return cls._build_delivery_payload(
            raw_data=raw_data,
            out_track_id=final_track_id,
            card_template_id=final_template_id,
            card_data=build_general_card_params(**(card_params or {})),
        )

    @classmethod
    def create_general_card_update_payload(
        cls,
        *,
        out_track_id: str,
        card_params: Dict[str, Any],
    ) -> Dict[str, Any]:
        return {
            "outTrackId": out_track_id,
            "cardData": {
                "cardParamMap": convert_json_values_to_string(
                    build_general_card_params(**(card_params or {}))
                )
            },
        }

    # ==========================================
    # 回调响应辅助方法 (Callback Response)
    # ==========================================

    @staticmethod
    def _create_callback_payload(update_data: Dict[str, str]) -> Dict[str, Any]:
        """内部复用：构建回调响应基础结构"""
        return {
            "cardUpdateOptions": {"updateCardDataByKey": True},
            "cardData": {"cardParamMap": convert_json_values_to_string(update_data)}
        }

    @classmethod
    def create_general_card_callback_response(cls, update_data: Dict[str, Any]) -> Dict[str, Any]:
        """生成 generalCard 的即时回调响应"""
        return cls._create_callback_payload(update_data)
