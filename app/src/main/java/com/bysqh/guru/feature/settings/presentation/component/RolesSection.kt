package com.bysqh.guru.feature.settings.presentation.component

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.bysqh.guru.R
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bysqh.guru.core.theme.Spacing
import com.bysqh.guru.core.ui.SwipeToDeleteRow
import com.bysqh.guru.feature.agent.domain.role.Role
import com.bysqh.guru.feature.settings.presentation.PendingAvatar
import com.bysqh.guru.feature.settings.presentation.RolesUiState
import compose.icons.FeatherIcons
import compose.icons.feathericons.Check
import compose.icons.feathericons.Edit2
import compose.icons.feathericons.Plus
import compose.icons.feathericons.User
import com.bysqh.guru.core.ui.AppAlertDialog

/**
 * 角色页：选中哪个角色，对话就用哪份身份提示词。
 *
 * 左滑角色行可以删除（与技能、模型列表一致）；头像留空时用应用图标。
 */
@Composable
internal fun RolesSection(
    state: RolesUiState,
    pendingCrop: PendingAvatar?,
    onSelect: (String) -> Unit,
    onCreate: (String) -> Role,
    onSave: (Role) -> Unit,
    onDelete: (String) -> Boolean,
    onPickAvatar: (String, Uri) -> Unit,
    onCancelCrop: () -> Unit,
    onCommitCrop: (ByteArray) -> Unit,
    onRemoveAvatar: (String) -> Unit
) {
    var editing by remember { mutableStateOf<Role?>(null) }
    var creating by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var deleteBlocked by remember { mutableStateOf(false) }
    // 下拉/新建时的默认角色名（stringResource 必须在 @Composable 作用域取好，不能放进 onClick）
    val defaultRoleName = stringResource(R.string.role_default_name)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.lg)
            .padding(bottom = Spacing.xl),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm)
    ) {
        Text(
            text = stringResource(R.string.role_intro),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = Spacing.sm)
        )

        SettingsGroupHeader(text = stringResource(R.string.role_group_title))
        SettingsGroup {
            state.roles.forEachIndexed { index, role ->
                if (index > 0) SettingsDivider()
                SwipeToDeleteRow(
                    onDelete = {
                        if (!onDelete(role.id)) deleteBlocked = true
                    },
                    onClick = { onSelect(role.id) }
                ) {
                    RoleRow(
                        role = role,
                        selected = role.id == state.currentId,
                        onEdit = { editing = role }
                    )
                }
            }
        }

        SettingsGroup {
            SettingsRow(
                icon = FeatherIcons.Plus,
                title = stringResource(R.string.role_new),
                subtitle = stringResource(R.string.role_new_blank),
                onClick = {
                    newName = ""
                    creating = true
                }
            )
        }
    }

    // 编辑弹窗里的头像要跟着最新状态走，否则换完头像点保存会用打开弹窗时的旧值覆盖掉。
    val editingLive = editing?.let { open ->
        state.roles.firstOrNull { it.id == open.id } ?: open
    }

    editingLive?.let { role ->
        RoleEditorDialog(
            role = role,
            canDelete = state.roles.size > 1,
            onDismiss = { editing = null },
            onSave = { updated ->
                onSave(updated)
                editing = null
            },
            onDelete = {
                if (onDelete(role.id)) editing = null else deleteBlocked = true
            },
            onPickAvatar = { uri -> onPickAvatar(role.id, uri) },
            onRemoveAvatar = { onRemoveAvatar(role.id) }
        )
    }

    if (creating) {
        AppAlertDialog(
            onDismissRequest = { creating = false },
            title = { Text(stringResource(R.string.role_new)) },
            text = {
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    singleLine = true,
                    label = { Text(stringResource(R.string.role_name_label)) },
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val role = onCreate(newName.trim().ifBlank { defaultRoleName })
                        onSelect(role.id)
                        creating = false
                        editing = role
                    }
                ) { Text(stringResource(R.string.common_create)) }
            },
            dismissButton = { TextButton(onClick = { creating = false }) { Text(stringResource(R.string.common_cancel)) } }
        )
    }

    if (deleteBlocked) {
        AppAlertDialog(
            onDismissRequest = { deleteBlocked = false },
            title = { Text(stringResource(R.string.role_cannot_delete_title)) },
            text = { Text(stringResource(R.string.role_cannot_delete_message)) },
            confirmButton = { TextButton(onClick = { deleteBlocked = false }) { Text(stringResource(R.string.common_got_it)) } }
        )
    }

    pendingCrop?.let { pending ->
        AvatarCropDialog(
            source = pending.source,
            onCancel = onCancelCrop,
            onConfirm = onCommitCrop
        )
    }
}

@Composable
private fun RoleRow(
    role: Role,
    selected: Boolean,
    onEdit: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.md, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        RoleAvatar(role = role, size = 40)
        Spacer(Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = role.name,
                style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = if (role.identity.isBlank()) stringResource(R.string.role_identity_empty) else stringResource(R.string.role_identity_length, role.identity.length),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.sp),
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (selected) {
            Image(
                imageVector = FeatherIcons.Check,
                contentDescription = stringResource(R.string.role_current),
                modifier = Modifier.size(16.dp)
            )
            Spacer(Modifier.width(8.dp))
        }
        Box(
            modifier = Modifier
                .size(32.dp)
                .clickable(onClick = onEdit),
            contentAlignment = Alignment.Center
        ) {
            Image(
                imageVector = FeatherIcons.Edit2,
                contentDescription = stringResource(R.string.common_edit),
                modifier = Modifier.size(16.dp)
            )
        }
    }
}

/** 头像：有自定义图就用它，否则回退到应用图标。 */
@Composable
internal fun RoleAvatar(role: Role, size: Int) {
    val context = LocalContext.current
    val bitmap = remember(role.avatarPath) {
        role.avatarPath?.let { path ->
            runCatching { BitmapFactory.decodeFile(path)?.asImageBitmap() }.getOrNull()
        }
    }
    val appIcon = remember {
        runCatching {
            val drawable = context.packageManager.getApplicationIcon(context.packageName)
            val w = drawable.intrinsicWidth.coerceAtLeast(1)
            val h = drawable.intrinsicHeight.coerceAtLeast(1)
            val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bmp)
            drawable.setBounds(0, 0, canvas.width, canvas.height)
            drawable.draw(canvas)
            bmp.asImageBitmap()
        }.getOrNull()
    }

    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center
    ) {
        val shown = bitmap ?: appIcon
        if (shown != null) {
            Image(
                bitmap = shown,
                contentDescription = role.name,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop
            )
        } else {
            Image(
                imageVector = FeatherIcons.User,
                contentDescription = role.name,
                modifier = Modifier.size((size * 0.5).dp)
            )
        }
    }
}

@Composable
private fun RoleEditorDialog(
    role: Role,
    canDelete: Boolean,
    onDismiss: () -> Unit,
    onSave: (Role) -> Unit,
    onDelete: () -> Unit,
    onPickAvatar: (Uri) -> Unit,
    onRemoveAvatar: () -> Unit
) {
    var name by remember(role.id) { mutableStateOf(role.name) }
    var identity by remember(role.id) { mutableStateOf(role.identity) }
    val context = LocalContext.current

    val avatarPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri -> uri?.let(onPickAvatar) }

    val identityImporter = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        runCatching {
            context.contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
        }.getOrNull()?.let { identity = it }
    }

    AppAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.role_edit_title)) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 460.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RoleAvatar(role = role, size = 56)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        TextButton(onClick = { avatarPicker.launch("image/*") }) {
                            Text(stringResource(R.string.role_change_avatar))
                        }
                        if (role.avatarPath != null) {
                            TextButton(onClick = onRemoveAvatar) {
                                Text(stringResource(R.string.role_remove_avatar), color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    label = { Text(stringResource(R.string.role_name_label)) },
                    modifier = Modifier.fillMaxWidth()
                )
                OutlinedTextField(
                    value = identity,
                    onValueChange = { identity = it },
                    label = { Text(stringResource(R.string.role_identity)) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 140.dp),
                    maxLines = 12
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { identityImporter.launch("*/*") }) {
                        Text(stringResource(R.string.role_import_prompt))
                    }
                    if (canDelete) {
                        TextButton(onClick = onDelete) {
                            Text(stringResource(R.string.role_delete), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onSave(role.copy(name = name.trim().ifBlank { role.name }, identity = identity))
                }
            ) { Text(stringResource(R.string.common_save)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } }
    )
}
