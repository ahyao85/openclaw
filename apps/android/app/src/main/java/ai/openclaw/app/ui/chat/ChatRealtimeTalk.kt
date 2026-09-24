package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gatewayTalkSetupDescriptionText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.requiresSetup
import ai.openclaw.app.ui.FoldAwarePrompt
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

internal enum class ChatRealtimeTalkLaunch {
  RequestPermission,
  ShowSetupMessage,
  StartTalk,
}

/** Resolves the only side effect a Live Talk tap may perform. */
internal fun resolveChatRealtimeTalkLaunch(
  hasMicPermission: Boolean,
  requiresSetup: Boolean,
): ChatRealtimeTalkLaunch =
  when {
    !hasMicPermission -> ChatRealtimeTalkLaunch.RequestPermission
    requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupMessage
    else -> ChatRealtimeTalkLaunch.StartTalk
  }

@Composable
internal fun rememberChatRealtimeTalkLauncher(
  viewModel: MainViewModel,
  onStartTalk: () -> Unit = { viewModel.setTalkModeEnabled(true) },
): () -> Unit {
  val context = LocalContext.current
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val currentTalkSetup by rememberUpdatedState(talkSetupReadiness.realtimeTalk)
  var pendingStart by remember { mutableStateOf<(() -> Unit)?>(null) }
  val failureNotice by viewModel.talkFailureNotice.collectAsState()
  val setupMessage by viewModel.pendingTalkSetupMessage.collectAsState()
  val showSetupMessage = {
    viewModel.showTalkSetupMessage(gatewayTalkSetupDescriptionText(currentTalkSetup))
  }
  val shownFailure = failureNotice
  val shownSetup = setupMessage
  (shownFailure?.text ?: shownSetup?.resolveNativeTextResource())?.let { message ->
    val dismissMessage = {
      if (shownFailure != null) {
        viewModel.acknowledgeTalkModeFailure(shownFailure)
      } else if (shownSetup != null) {
        viewModel.dismissTalkSetupMessage(shownSetup)
      }
    }
    FoldAwarePrompt(
      onDismissRequest = dismissMessage,
      title = nativeString("Talk"),
      text = { Text(message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
      actions = {
        TextButton(onClick = dismissMessage) { Text(nativeString("OK")) }
      },
    )
  }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val start = pendingStart
      pendingStart = null
      if (!granted || start == null) return@rememberLauncherForActivityResult
      if (currentTalkSetup.requiresSetup) {
        showSetupMessage()
      } else {
        start()
      }
    }

  return {
    val gatewayId = viewModel.activeGatewayStableId.value
    val selectionGeneration = viewModel.chatSelectionGeneration.value
    val selectedKey = viewModel.chatSessionKey.value
    val selectedAgent = viewModel.chatSessionOwnerAgentId.value
    val start = {
      // A permission result cannot start audio for a different conversation or Gateway.
      if (viewModel.chatSelectionGeneration.value == selectionGeneration &&
        viewModel.activeGatewayStableId.value == gatewayId &&
        viewModel.chatSessionKey.value == selectedKey &&
        viewModel.chatSessionOwnerAgentId.value == selectedAgent
      ) {
        onStartTalk()
      }
    }
    when (
      resolveChatRealtimeTalkLaunch(
        hasMicPermission = context.hasRecordAudioPermission(),
        requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,
      )
    ) {
      ChatRealtimeTalkLaunch.RequestPermission -> {
        pendingStart = start
        requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
      }

      ChatRealtimeTalkLaunch.ShowSetupMessage -> {
        showSetupMessage()
      }

      ChatRealtimeTalkLaunch.StartTalk -> {
        start()
      }
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
