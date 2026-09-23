/** chat-image-anchor — 聊天视图 → 生图弹窗的「当前最后一条助手消息」锚点。
 *
 * 背景:UI 生图的图片要绑定到**生成那一刻**的最后一条助手消息(写进 ai_images.message_index,
 * 后端 /api/images/generate 已接受该字段)。游戏台(GameChatArea)与酒馆(tavern-app)各自算
 * lastAsstIdx、彼此隔离,而生图弹窗(GenerateImageModal)由 game-composer 挂载、拿不到任何一处
 * 的 ref —— 这里放一个最小单例做单向发布:聊天视图每帧刷新 lastAsstKey,弹窗在**点击生成时**读取。
 *
 * 为什么用"提交时读"而不是 prop:锚点必须是**点击那一刻**的值;经 props 传递拿到的是上一次
 * render 的快照,消息在此期间变化就会绑错。单例无时序耦合,两个聊天面发布同一个槽即可。
 */
export const chatImageAnchor = {
  /** 当前最后一条助手消息的绝对索引(String);没有助手消息时为 null。 */
  lastAsstKey: null,
};

export default chatImageAnchor;
