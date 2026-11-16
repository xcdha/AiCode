package com.bysqh.guru.feature.settings.presentation.component

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection

/**
 * 向后兼容别名：实现已迁移至 [com.bysqh.guru.core.ui.rememberSheetFlingFix]，
 * 并在 [com.bysqh.guru.core.ui.AdaptiveModalBottomSheet] 中自动集成。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun rememberSheetFlingFix(sheetState: SheetState): NestedScrollConnection =
    com.bysqh.guru.core.ui.rememberSheetFlingFix(sheetState)
